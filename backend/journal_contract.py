"""Pure, immutable source schema for journal guides; no application imports."""
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, Field, StringConstraints, model_validator

Id = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{0,63}$", strict=True)]
Label = Annotated[str, StringConstraints(max_length=120, strict=True)]
Title = Annotated[str, StringConstraints(max_length=240, strict=True)]
Body = Annotated[str, StringConstraints(max_length=8192, strict=True)]
Dimension = Annotated[int, Field(ge=1, le=4096, strict=True)]
FileId = Annotated[str, StringConstraints(pattern=r"^file-[A-Za-z0-9_-]{1,100}$", strict=True)]
Tone = Literal["neutral", "info", "success", "warning"]


def _nonblank(value: str) -> str:
    # Validate without stripping: the published tree must equal its saved source.
    # JS trim (used by the editor) also treats the Unicode BOM as whitespace.
    if not value.replace("\ufeff", "").strip():
        raise ValueError("Заполните обязательное поле")
    return value


RequiredLabel = Annotated[Label, AfterValidator(_nonblank)]
RequiredTitle = Annotated[Title, AfterValidator(_nonblank)]


class Frozen(BaseModel):
    model_config = {"extra": "forbid", "frozen": True}


class Poster(Frozen):
    kind: Literal["poster"]
    eyebrow: Label
    title: RequiredTitle
    caption: Title
    tone: Literal["yellow", "mint", "peach", "sky", "lilac"]


class ImageFields(Frozen):
    file_id: FileId
    alt: RequiredTitle
    caption: Title
    width: Dimension
    height: Dimension


class ImageCover(ImageFields):
    kind: Literal["image"]


class Text(Frozen):
    id: Id
    type: Literal["text"]
    body: Body


class Note(Frozen):
    id: Id
    type: Literal["note"]
    tone: Tone
    title: Title
    body: Body


class Comparison(Frozen):
    id: Id
    type: Literal["comparison"]
    before_label: RequiredLabel
    before: Body
    after_label: RequiredLabel
    after: Body


class Fact(Frozen):
    label: RequiredLabel
    body: Body


class Facts(Frozen):
    id: Id
    type: Literal["facts"]
    items: Annotated[tuple[Fact, ...], Field(min_length=2, max_length=4)]


class Step(Frozen):
    role: Label
    title: RequiredTitle
    body: Body


class Steps(Frozen):
    id: Id
    type: Literal["steps"]
    items: Annotated[tuple[Step, ...], Field(min_length=2, max_length=6)]


class Image(ImageFields):
    id: Id
    type: Literal["image"]
    collapsed: Annotated[bool, Field(strict=True)]


class Disclosure(Frozen):
    id: Id
    type: Literal["disclosure"]
    title: RequiredTitle
    body: Body


class Option(Frozen):
    id: Id
    label: RequiredLabel
    body: Body


class Switcher(Frozen):
    id: Id
    type: Literal["switcher"]
    title: RequiredTitle
    options: Annotated[tuple[Option, ...], Field(min_length=2, max_length=4)]

    @model_validator(mode="after")
    def distinct_options(self):
        if len({option.id for option in self.options}) != len(self.options):
            raise ValueError("Идентификаторы вариантов должны различаться")
        return self


class Legacy(Frozen):
    id: Id
    type: Literal["legacy"]
    body: Annotated[str, StringConstraints(strict=True)]

    @model_validator(mode="after")
    def bounded_source(self):
        if len(self.body.encode("utf-8")) > 128 * 1024:
            raise ValueError("Импортированный текст превышает 128 КиБ")
        return self


Block = Annotated[Text | Note | Comparison | Facts | Steps | Image | Disclosure | Switcher | Legacy, Field(discriminator="type")]


class Section(Frozen):
    id: Id
    label: Label
    title: RequiredTitle
    blocks: Annotated[tuple[Block, ...], Field(min_length=1, max_length=20)]


class JournalDocument(Frozen):
    version: Literal[1]
    eyebrow: Label
    intro: Annotated[str, StringConstraints(max_length=1000, strict=True)]
    cover: Annotated[Poster | ImageCover, Field(discriminator="kind")] | None
    sections: Annotated[tuple[Section, ...], Field(min_length=1, max_length=20)]

    @model_validator(mode="after")
    def bounded_sections(self):
        ids = [section.id for section in self.sections]
        ids.extend(block.id for section in self.sections for block in section.blocks)
        if len(ids) != len(set(ids)):
            raise ValueError("Идентификаторы разделов и блоков должны различаться")
        if sum(len(section.blocks) for section in self.sections) > 60:
            raise ValueError("В журнале допускается не больше 60 блоков")
        return self
