"""Public response schemas for the API 1.3 domain extensions."""

from typing import Literal
from pydantic import BaseModel


class RichText(BaseModel):
    format: Literal["markdown"] = "markdown"
    body: str


class UserReference(BaseModel):
    user_id: int | None
    display_name: str
    avatar_url: str | None = None


class RegistrationFields(BaseModel):
    surname: str
    name: str
    patronymic: str | None
    group_number: str
    phone: str
    email: str
    tg: str
    vk: str
    funding: Literal["budget", "contract"] | None  # a VK application starts unchosen (decision 28)
    residence: str


class RegistrationApplication(BaseModel):
    user_id: int
    status: Literal["pending", "approved", "rejected"]
    attempts_used: int
    attempt_limit: Literal[5]
    total_submissions: int
    rejection_reason: str | None
    fields: RegistrationFields
    revision: int
    capabilities: list[str]


class BlockRequest(BaseModel):
    request_id: str
    user: UserReference
    block_id: str
    state: Literal["pending_hr", "pending_block", "approved", "rejected", "withdrawn"]
    created_at: str
    stage_entered_at: str
    substitute_available_at: str | None
    # A closed request: when it was decided and, for a rejection, why (decision 16)
    decided_at: str | None = None
    decision_reason: str | None = None
    revision: int
    capabilities: list[str]


class Material(BaseModel):
    material_id: str
    kind: Literal["guide", "general", "kmb"]
    owner_block_id: str | None
    title: str
    description: str
    original_link: str | None
    published_content: RichText | None
    draft_content: RichText | None = None
    # Only for editors: the stored text to edit, with file:<id> and unsigned links.
    source_content: RichText | None = None
    editor_user_ids: list[int] | None = None
    # Block guides only: "block" reads to the block, "everyone" to every participant.
    audience: Literal["block", "everyone"] | None = None
    revision: int
    capabilities: list[str]


class EditorAssignment(BaseModel):
    material_id: str
    editor_user_ids: list[int]
    revision: int


class FormerContact(BaseModel):
    contact_id: str
    surname: str
    name: str
    patronymic: str | None = None
    phone: str
    email: str
    tg: str
    vk: str
    participation_periods: list[dict[str, int]]


class ArchivedAccount(BaseModel):
    user_id: int
    display_name: str
    archived_at: str
    master_conflicts: list[dict]


class AccountState(BaseModel):
    user_id: int
    account_state: Literal["active", "archived"]
    archived_at: str | None = None
    skipped_assignment_ids: list[str] | None = None
