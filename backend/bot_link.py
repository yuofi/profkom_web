"""HereBot stages 2 and 3: the VK link policy, without the database (backend/docs/BOT_API.md).

An account's link lives in bot_links; its state is copied to users.bot_link_state in the same
transaction, so the working-access gate and /api/session decide from the users row they have
already read. Everything here is off while BOT_API_TOKEN_SHA256 is empty.
"""
from datetime import datetime, timezone

from settings import settings

TOKEN_STATUSES = ("ok", "missing", "invalid", "unknown")
# Stage 3: the states whose VK takes the community's messages (a token is not needed to send).
SENDABLE = ("ok", "token_missing", "token_invalid")
# Open after the deadline besides the routes free anyway (auth._access_rules): the link
# routes and the bot console, which checks its own rights.
OPEN_PREFIXES = ("/bot-link/", "/bot/console/")


def utcnow():
    return datetime.now(timezone.utc)


def stamp(moment):
    """ISO 8601 UTC with `Z`, whole seconds: the wire format and the stored text order."""
    moment = moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse(text):
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def enabled():
    return bool(settings.BOT_API_TOKEN_SHA256)


def state_of(link):
    """None without a link, else the first unmet condition in the contract's order. A token VK
    did not answer about (`unknown`) satisfies the step: a VK failure does not close the site."""
    if link is None:
        return None
    if not link.messages_allowed:
        return "messages_denied"
    if link.token_status == "missing":
        return "token_missing"
    if link.token_status == "invalid":
        return "token_invalid"
    return "ok"


def required(user, now):
    """Pending accounts always; active ones from BOT_LINK_DEADLINE."""
    if not enabled():
        return False
    if user.account_state == "pending":
        return True
    deadline = settings.BOT_LINK_DEADLINE
    return user.account_state == "active" and deadline is not None and now >= deadline


def blocked(user, now=None):
    """An active account past the deadline without a working link."""
    return (user.account_state == "active" and user.bot_link_state != "ok"
            and required(user, now or utcnow()))


def summary(user, now=None):
    """`bot_link` of /api/session: {state, required, blocked, deadline}, None while off."""
    if not enabled():
        return None
    now = now or utcnow()
    deadline = settings.BOT_LINK_DEADLINE
    return dict(state=user.bot_link_state or "none", required=required(user, now),
                blocked=blocked(user, now), deadline=stamp(deadline) if deadline else None)
