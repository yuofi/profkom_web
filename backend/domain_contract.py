"""Public response schemas for the API 1.3 domain extensions."""

from typing import Literal
from pydantic import BaseModel, Field
from journal_contract import JournalDocument


class RichText(BaseModel):
    format: Literal["markdown"] = "markdown"
    body: str


class GuideNodeAttrs(BaseModel):
    model_config = {"extra": "forbid", "frozen": True}
    classes: tuple[str, ...] | None = None
    href: str | None = None
    anchor: str | None = None
    src: str | None = None
    alt: str | None = None
    width: int | None = None
    height: int | None = None
    scope: str | None = None
    colspan: int | None = None
    rowspan: int | None = None
    start: int | None = None
    value: int | None = None
    open: bool | None = None


class GuideNode(BaseModel):
    model_config = {"extra": "forbid", "frozen": True}
    tag: str
    text: str
    attrs: GuideNodeAttrs
    children: tuple["GuideNode", ...]


class GuideEmbedBlock(BaseModel):
    model_config = {"extra": "forbid", "frozen": True}
    id: str
    source: str
    nodes: tuple[GuideNode, ...]
    text: str


class GuideDiagnostic(BaseModel):
    model_config = {"extra": "forbid", "frozen": True}
    block_id: str | None
    line: int
    code: str
    message: str


class GuideRender(BaseModel):
    model_config = {"extra": "forbid", "frozen": True}
    schema_version: Literal[1]
    policy_version: Literal[1]
    source_hash: str
    blocks: tuple[GuideEmbedBlock, ...]
    diagnostics: tuple[GuideDiagnostic, ...]
    file_ids: tuple[str, ...]


class JournalLegacy(BaseModel):
    model_config = {"extra": "forbid", "frozen": True}
    block_id: str
    render: GuideRender


class JournalRender(BaseModel):
    model_config = {"extra": "forbid", "frozen": True}
    schema_version: Literal[2]
    policy_version: Literal[1]
    source_hash: str
    document: JournalDocument | None
    legacy: tuple[JournalLegacy, ...]
    diagnostics: tuple[GuideDiagnostic, ...]
    file_ids: tuple[str, ...]
    image_file_ids: tuple[str, ...]


class MaterialContent(BaseModel):
    format: Literal["markdown", "markdown-embeds-v1", "journal-v1"] = "markdown"
    body: str
    render: GuideRender | JournalRender | None = None


class UserReference(BaseModel):
    user_id: int | None
    display_name: str
    avatar_url: str | None = None


class RegistrationFields(BaseModel):
    surname: str
    name: str
    patronymic: str | None
    no_patronymic: bool = False
    group_number: str
    phone: str
    email: str
    tg: str
    vk: str
    funding: Literal["budget", "contract"] | None  # a VK application starts unchosen (decision 28)
    residence: str


class RegistrationBotLink(BaseModel):
    """The applicant's VK link through the bot (BOT_API.md, stage 2)."""
    state: Literal["none", "ok", "messages_denied", "token_missing", "token_invalid"]
    vk_user_id: int | None


class RegistrationDecision(BaseModel):
    outcome: Literal["approved", "rejected"]
    actor: UserReference | None
    at: str | None


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
    # None while the bot integration is off
    bot_link: RegistrationBotLink | None = None
    decision: RegistrationDecision | None = None


class BlockRequestApproval(BaseModel):
    stage: Literal["hr", "block"]
    actor: UserReference | None
    at: str | None
    substitute: bool


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
    approvals: list[BlockRequestApproval] = Field(default_factory=list)
    revision: int
    capabilities: list[str]


class Material(BaseModel):
    material_id: str
    kind: Literal["guide", "general", "kmb"]
    owner_block_id: str | None
    title: str
    description: str
    original_link: str | None
    published_content: MaterialContent | None
    draft_content: MaterialContent | None = None
    # Only for editors: the stored text to edit, with file:<id> and unsigned links.
    source_content: MaterialContent | None = None
    editor_user_ids: list[int] | None = None
    # Block guides only: "block" reads to the block, "everyone" to every participant.
    audience: Literal["block", "everyone", "leadership"] | None = None
    revision: int
    capabilities: list[str]
    deleted_at: str | None = None
    placeholder: bool = False
    community_url: str | None = None
    published_at: str | None = None


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
    capabilities: list[str] = []


class AccountState(BaseModel):
    user_id: int
    account_state: Literal["active", "archived"]
    archived_at: str | None = None
    skipped_assignment_ids: list[str] | None = None
