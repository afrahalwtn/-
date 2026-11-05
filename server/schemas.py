from pydantic import BaseModel, ConfigDict, Field, field_validator

class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

class LoginInput(StrictModel):
    username: str = Field(min_length=3, max_length=60, pattern=r"^[a-zA-Z0-9_.-]+$")
    password: str = Field(min_length=1, max_length=512)

class ProductInput(StrictModel):
    name: str = Field(min_length=1, max_length=140)
    description: str = Field(default="", max_length=1500)
    manufacture: str = Field(default="", max_length=140)
    quantity: int = Field(ge=0, le=100_000_000)
    min_quantity: int = Field(ge=0, le=100_000_000)
    purchase_price: int = Field(ge=0, le=1_000_000_000_000)
    sale_price: int = Field(ge=0, le=1_000_000_000_000)

class StockInput(StrictModel):
    quantity: int = Field(ge=0, le=100_000_000)

class StaffInput(StrictModel):
    username: str = Field(min_length=3, max_length=60, pattern=r"^[a-zA-Z0-9_.-]+$")
    full_name: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=12, max_length=256)
    can_view_purchase: bool = False
    can_view_sale: bool = False

class StaffUpdate(StrictModel):
    full_name: str | None = Field(default=None, min_length=2, max_length=120)
    password: str | None = Field(default=None, min_length=12, max_length=256)
    can_view_purchase: bool | None = None
    can_view_sale: bool | None = None
    is_active: bool | None = None

class QuoteItemInput(StrictModel):
    product_id: int = Field(gt=0)
    quantity: int = Field(ge=1, le=100_000_000)

class QuoteInput(StrictModel):
    items: list[QuoteItemInput] = Field(min_length=1, max_length=50)

    @field_validator("items")
    @classmethod
    def distinct_items(cls, items):
        ids = [x.product_id for x in items]
        if len(set(ids)) != len(ids):
            raise ValueError("لا تكرر المادة نفسها في عرض الأسعار")
        return items
