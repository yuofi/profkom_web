"""An explicit patronymic decision shared by both registration entry points."""
from pydantic import BaseModel, Field, StrictBool, ValidationInfo, field_validator


class PatronymicChoice(BaseModel):
    # Validate this first so the patronymic validator sees the actual boolean.
    no_patronymic: StrictBool = False
    patronymic: str | None = Field(default=None, max_length=100, validate_default=True)

    @field_validator("patronymic", mode="before")
    @classmethod
    def trim_patronymic(cls, value):
        return value.strip() if isinstance(value, str) else value

    @field_validator("patronymic")
    @classmethod
    def require_patronymic_decision(cls, value, info: ValidationInfo):
        absent = info.data.get("no_patronymic", False)
        if absent and value:
            raise ValueError("Уберите отчество или снимите галочку «У меня нет отчества»")
        if not absent and not value:
            raise ValueError("Укажите отчество или отметьте «У меня нет отчества»")
        return value or None
