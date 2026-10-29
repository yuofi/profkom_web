"""Memoization confined to one explicitly read-only database unit of work.

There is no process cache. A write (including a lazy read repair), dirty ORM state,
flush or transaction boundary permanently disables the scope. Commands and ordinary
Database calls outside a read UOW retain their uncached behavior.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from functools import wraps

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session


_KEY = "profkom_read_context"
_current = ContextVar(_KEY, default=None)


class ReadContext:
    def __init__(self, session):
        self.session = session
        self.enabled = True
        self.values = {}
        # SQLAlchemy's identity map uses weak references. Keep already-read objects
        # alive only for this UOW, avoiding repeated PK hydration without new ACL.
        self.references = dict(session.identity_map.items())

    def disable(self):
        self.enabled = False
        self.values.clear()
        self.references.clear()

    def usable(self):
        if self.enabled and (self.session.new or self.session.dirty or self.session.deleted
                             or not self.session.is_active):
            self.disable()
        return self.enabled


def _context(session):
    return session.info.get(_KEY)


def invalidate(session=None):
    """A mixed workflow never resumes caching after its first possible write."""
    context = _context(session) if session is not None else _current.get()
    if context is not None:
        context.disable()


@contextmanager
def read_scope(session):
    previous = session.info.get(_KEY)
    if previous is not None:
        # A nested reader cannot revive a scope disabled by an earlier write.
        yield previous
        return
    context = ReadContext(session)
    session.info[_KEY] = context
    token = _current.set(context)
    try:
        yield context
    finally:
        context.disable()
        if previous is None:
            session.info.pop(_KEY, None)
        else:
            session.info[_KEY] = previous
        _current.reset(token)


def cached(session, namespace, key, load, *, copy_result=True):
    """Return a detached value, never a mutable shared DTO/ACL set.

    ``copy_result=False`` is reserved for immutable values such as frozenset/bool.
    The loader may itself repair data; recheck the scope before retaining its result.
    """
    context = _context(session)
    if context is None or not context.usable():
        return load()
    cache_key = (namespace, key)
    if cache_key not in context.values:
        value = load()
        if not context.usable():
            return value
        context.values[cache_key] = deepcopy(value) if copy_result else value
    value = context.values[cache_key]
    return deepcopy(value) if copy_result else value


def cached_current(namespace, key, load, *, copy_result=True):
    context = _current.get()
    if context is None:
        return load()
    return cached(context.session, namespace, key, load, copy_result=copy_result)


def memoized(namespace, *, copy_result=True):
    """For pure helpers with hashable arguments (no ORM/Session arguments)."""
    def decorate(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            key = (args, tuple(sorted(kwargs.items())))
            return cached_current(namespace, key, lambda: function(*args, **kwargs),
                                  copy_result=copy_result)
        return wrapped
    return decorate


@event.listens_for(Session, "loaded_as_persistent")
def _hold_loaded(session, instance):
    context = _context(session)
    if context is not None and context.usable():
        context.references[id(instance)] = instance


@event.listens_for(Session, "before_flush")
def _before_flush(session, *_args):
    invalidate(session)


@event.listens_for(Session, "do_orm_execute")
def _before_execute(state):
    # Textual SQL is deliberately conservative, including raw SELECT: the cache
    # must never survive an unclassified command or bulk update/delete.
    if not state.is_select:
        invalidate(state.session)


@event.listens_for(Session, "after_commit")
@event.listens_for(Session, "after_rollback")
def _transaction_finished(session):
    invalidate(session)


@event.listens_for(Session, "after_soft_rollback")
def _savepoint_rollback(session, _previous_transaction):
    invalidate(session)


def install_engine(engine):
    """Also cover DML sent directly through session.connection()/driver SQL."""
    @event.listens_for(engine, "before_cursor_execute")
    def _connection_execute(_conn, _cursor, _statement, _params, execution, _many):
        context = _current.get()
        if context is None:
            return
        compiled = execution.compiled
        if compiled is None or not getattr(compiled.statement, "is_select", False):
            context.disable()
            execution._profkom_read_session = context.session

    @event.listens_for(engine, "after_cursor_execute")
    def _refresh_after_command(_conn, _cursor, _statement, _params, execution, _many):
        session = getattr(execution, "_profkom_read_session", None)
        if session is None or session._flushing:
            return
        # Core/driver DML does not synchronize SQLAlchemy's identity map. Clearing
        # memo alone is insufficient when a caller still holds a User/grant/roster
        # object. Expire only unchanged loaded attributes: pending ORM edits must
        # survive a mixed workflow. ORM flush handles its own in-memory state.
        for instance in list(session.identity_map.values()):
            state = inspect(instance)
            if not state.persistent or instance in session.deleted:
                continue
            primary_keys = {column.key for column in state.mapper.primary_key}
            names = [attr.key for attr in state.mapper.attrs
                     if attr.key not in primary_keys and attr.key in state.dict
                     and not state.attrs[attr.key].history.has_changes()]
            if names:
                session.expire(instance, names)
