"""Afrah Al-Watan application. All access rules are enforced on the server."""
from __future__ import annotations

from datetime import timedelta
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from secrets import token_bytes
import os
import re
from uuid import uuid4

from PIL import Image, ImageOps, UnidentifiedImageError
from fastapi import FastAPI, Request, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from sqlalchemy import select, func, or_, delete
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from .models import User, LoginSession, Product, Quote, QuoteLine, now_utc
from .database import make_database
from .schemas import LoginInput, ProductInput, StockInput, StaffInput, StaffUpdate, QuoteInput
from .security import (
    get_db, current_user, require_admin, csrf_guard, admin_write, get_session,
    hash_password, verify_password, token_digest, new_token, csrf_for_token, LoginLimiter,
)

HERE = Path(__file__).resolve().parents[1]


def user_dict(u: User):
    return {
        "id": u.id, "username": u.username, "full_name": u.full_name,
        "role": u.role, "can_view_purchase": u.role == "admin" or u.can_view_purchase,
        "can_view_sale": u.role == "admin" or u.can_view_sale,
        "is_active": u.is_active,
    }


def product_dict(p: Product, u: User):
    data = {
        "id": p.id, "name": p.name, "description": p.description,
        "manufacture": p.manufacture, "quantity": p.quantity,
        "min_quantity": p.min_quantity,
        "image_url": f"/api/images/{p.image_name}" if p.image_name else None,
        "low_stock": p.quantity <= p.min_quantity,
    }
    if u.role == "admin" or u.can_view_purchase:
        data["purchase_price"] = p.purchase_price
    if u.role == "admin" or u.can_view_sale:
        data["sale_price"] = p.sale_price
    return data


def quote_dict(q: Quote):
    return {
        "id": q.id, "date": q.created_at.isoformat(),
        "items": [{
            "product_name": r.product_name, "description": r.description,
            "manufacture": r.manufacture, "quantity": r.quantity,
            "unit_price": r.unit_price, "total": r.unit_price * r.quantity,
            "image_url": f"/api/images/{r.image_name}" if r.image_name else None,
        } for r in q.items],
        "total": sum(r.unit_price * r.quantity for r in q.items),
    }


def create_app(db_url: str | None = None, data_dir: str | Path | None = None, *, cookie_secure: bool | None = None) -> FastAPI:
    app = FastAPI(title="Afrah Al-Watan", version="1.0.0", docs_url=None, redoc_url=None, openapi_url=None)
    data = Path(data_dir or os.environ.get("AFRAH_DATA_DIR", str(HERE / "data"))).resolve()
    os.umask(0o077)
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(data, 0o700)
    (data / "images").mkdir(exist_ok=True, mode=0o700)
    os.chmod(data / "images", 0o700)
    # First boot creates a private local secret, not a hardcoded secret in source code.
    secret_path = data / "secret.key"
    if not secret_path.exists():
        fd = os.open(secret_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(token_bytes(32))
    secret = secret_path.read_bytes()
    if len(secret) < 32:
        raise RuntimeError("Invalid private secret key")
    if db_url is None:
        db_url = os.environ.get("AFRAH_DATABASE_URL", f"sqlite:///{data / 'afrah.sqlite3'}")
    engine, factory = make_database(db_url)
    if db_url.startswith("sqlite:///"):
        path = Path(db_url[len("sqlite:///"):])
        if path.exists(): os.chmod(path, 0o600)
    app.state.engine, app.state.session_factory = engine, factory
    app.state.data_dir, app.state.secret = data, secret
    app.state.login_limiter = LoginLimiter()
    app.state.cookie_secure = (os.getenv("AFRAH_SECURE_COOKIES", "false").lower() == "true") if cookie_secure is None else cookie_secure
    allowed_hosts = [h.strip() for h in os.getenv("AFRAH_ALLOWED_HOSTS", "localhost,127.0.0.1,testserver").split(",") if h.strip()]
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        # Avoid accepting state-changing cross-site browser requests, including login.
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            origin = request.headers.get("origin")
            if origin:
                host = request.headers.get("host", "")
                permitted = {f"http://{host}", f"https://{host}"}
                if origin not in permitted:
                    return JSONResponse({"detail": "مصدر الطلب غير مسموح"}, status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
            "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        )
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.post("/api/auth/login")
    def login(payload: LoginInput, request: Request, db: Session = Depends(get_db)):
        source = (request.client.host if request.client else "unknown")[:120]
        key = source + "|" + payload.username.lower()
        limiter: LoginLimiter = app.state.login_limiter
        if not limiter.permitted(key):
            raise HTTPException(429, "محاولات كثيرة. حاول مجدداً بعد 15 دقيقة")
        u = db.scalar(select(User).where(User.username == payload.username.lower()))
        if not u or not u.is_active or not verify_password(payload.password, u.password_hash):
            limiter.fail(key)
            raise HTTPException(401, "اسم المستخدم أو كلمة المرور غير صحيحة")
        limiter.clear(key)
        raw = new_token()
        now = now_utc()
        db.add(LoginSession(token_hash=token_digest(raw), user_id=u.id, created_at=now, last_seen_at=now, expires_at=now + timedelta(hours=12)))
        db.commit()
        reply = JSONResponse({"user": user_dict(u), "csrf": csrf_for_token(app.state.secret, raw)})
        reply.set_cookie("afrah_session", raw, httponly=True, secure=app.state.cookie_secure, samesite="strict", path="/", max_age=12 * 3600)
        return reply

    @app.get("/api/me")
    def me(request: Request, db: Session = Depends(get_db)):
        u, _, raw = get_session(request, db)
        return {"user": user_dict(u), "csrf": csrf_for_token(app.state.secret, raw)}

    @app.post("/api/auth/logout")
    def logout(request: Request, _: User = Depends(csrf_guard), db: Session = Depends(get_db)):
        token = request.cookies.get("afrah_session", "")
        if token:
            db.execute(delete(LoginSession).where(LoginSession.token_hash == token_digest(token)))
            db.commit()
        response = JSONResponse({"ok": True})
        response.delete_cookie("afrah_session", path="/")
        return response

    @app.get("/api/products")
    def products(q: str = "", db: Session = Depends(get_db), user: User = Depends(current_user)):
        stmt = select(Product).order_by(Product.id.desc())
        if q.strip():
            term = "%" + q.strip()[:100].replace("%", "\\%").replace("_", "\\_") + "%"
            stmt = stmt.where(or_(Product.name.ilike(term, escape="\\"), Product.description.ilike(term, escape="\\")))
        rows = db.scalars(stmt.limit(1000)).all()
        return [product_dict(p, user) for p in rows]

    @app.post("/api/products", status_code=201)
    def add_product(payload: ProductInput, db: Session = Depends(get_db), user: User = Depends(admin_write)):
        p = Product(**payload.model_dump())
        db.add(p)
        db.commit()
        db.refresh(p)
        return product_dict(p, user)

    @app.put("/api/products/{product_id}")
    def update_product(product_id: int, payload: ProductInput, db: Session = Depends(get_db), user: User = Depends(admin_write)):
        p = db.get(Product, product_id)
        if not p:
            raise HTTPException(404, "المادة غير موجودة")
        for k, v in payload.model_dump().items():
            setattr(p, k, v)
        db.commit()
        return product_dict(p, user)

    @app.patch("/api/products/{product_id}/stock")
    def update_stock(product_id: int, payload: StockInput, db: Session = Depends(get_db), user: User = Depends(admin_write)):
        p = db.get(Product, product_id)
        if not p:
            raise HTTPException(404, "المادة غير موجودة")
        p.quantity = payload.quantity
        db.commit()
        return product_dict(p, user)

    @app.delete("/api/products/{product_id}")
    def delete_product(product_id: int, db: Session = Depends(get_db), _: User = Depends(admin_write)):
        p = db.get(Product, product_id)
        if not p:
            raise HTTPException(404, "المادة غير موجودة")
        db.delete(p)
        db.commit()
        return {"ok": True}

    @app.post("/api/products/{product_id}/image")
    async def upload_image(product_id: int, file: UploadFile = File(...), db: Session = Depends(get_db), _: User = Depends(admin_write)):
        p = db.get(Product, product_id)
        if not p:
            raise HTTPException(404, "المادة غير موجودة")
        # Bound network read; never trust Content-Type or filename.
        contents = await file.read(3 * 1024 * 1024 + 1)
        if len(contents) > 3 * 1024 * 1024:
            raise HTTPException(413, "حجم الصورة الأقصى 3 ميغابايت")
        try:
            im = Image.open(BytesIO(contents))
            if im.format not in ("JPEG", "PNG", "WEBP"):
                raise ValueError("invalid format")
            im.verify()
            im = Image.open(BytesIO(contents))
            if im.width * im.height > 14_000_000:
                raise ValueError("too many pixels")
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((1400, 1400))
            filename = uuid4().hex + ".webp"
            image_file = data / "images" / filename
            im.save(image_file, "WEBP", quality=86, method=4)
            os.chmod(image_file, 0o600)
        except (UnidentifiedImageError, ValueError, OSError, Image.DecompressionBombError):
            raise HTTPException(415, "الملف ليس صورة صالحة")
        p.image_name = filename
        db.commit()
        return {"image_url": f"/api/images/{filename}"}

    @app.get("/api/images/{filename}")
    def get_image(filename: str, _: User = Depends(current_user)):
        if not re.fullmatch(r"[0-9a-f]{32}\.webp", filename):
            raise HTTPException(404, "الصورة غير موجودة")
        location = data / "images" / filename
        if not location.is_file():
            raise HTTPException(404, "الصورة غير موجودة")
        return FileResponse(location, media_type="image/webp", headers={"Cache-Control": "private, no-store"})

    @app.get("/api/alerts")
    def alerts(db: Session = Depends(get_db), _: User = Depends(current_user)):
        rows = db.scalars(select(Product).where(Product.quantity <= Product.min_quantity).order_by(Product.quantity, Product.name)).all()
        return [{"product_id": p.id, "name": p.name, "quantity": p.quantity, "min_quantity": p.min_quantity} for p in rows]

    @app.get("/api/users")
    def users(db: Session = Depends(get_db), _: User = Depends(require_admin)):
        return [user_dict(u) for u in db.scalars(select(User).order_by(User.id)).all()]

    @app.post("/api/users", status_code=201)
    def add_staff(payload: StaffInput, db: Session = Depends(get_db), _: User = Depends(admin_write)):
        u = User(username=payload.username.lower(), full_name=payload.full_name, password_hash=hash_password(payload.password), role="staff", can_view_purchase=payload.can_view_purchase, can_view_sale=payload.can_view_sale)
        db.add(u)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, "اسم المستخدم موجود")
        return user_dict(u)

    @app.patch("/api/users/{user_id}")
    def update_staff(user_id: int, payload: StaffUpdate, db: Session = Depends(get_db), _: User = Depends(admin_write)):
        u = db.get(User, user_id)
        if not u or u.role != "staff":
            raise HTTPException(404, "المستخدم غير موجود أو لا يمكن تعديله")
        for k, v in payload.model_dump(exclude_unset=True).items():
            if k == "password":
                if v is not None:
                    u.password_hash = hash_password(v)
                    # Invalidate sessions when credentials change.
                    db.execute(delete(LoginSession).where(LoginSession.user_id == u.id))
            elif v is not None:
                setattr(u, k, v)
        # Immediately revoke sessions on privilege changes / deactivation, so client must re-login.
        if {"can_view_purchase", "can_view_sale", "is_active"} & set(payload.model_fields_set):
            db.execute(delete(LoginSession).where(LoginSession.user_id == u.id))
        db.commit()
        return user_dict(u)

    @app.get("/api/quotes")
    def quotes(db: Session = Depends(get_db), _: User = Depends(require_admin)):
        rows = db.scalars(select(Quote).order_by(Quote.id.desc()).limit(100)).all()
        return [quote_dict(q) for q in rows]

    @app.get("/api/quotes/{quote_id}")
    def quote(quote_id: int, db: Session = Depends(get_db), _: User = Depends(require_admin)):
        q = db.get(Quote, quote_id)
        if not q:
            raise HTTPException(404, "عرض الأسعار غير موجود")
        return quote_dict(q)

    @app.post("/api/quotes", status_code=201)
    def add_quote(payload: QuoteInput, db: Session = Depends(get_db), user: User = Depends(admin_write)):
        ids = [row.product_id for row in payload.items]
        found = {p.id: p for p in db.scalars(select(Product).where(Product.id.in_(ids))).all()}
        if len(found) != len(ids):
            raise HTTPException(400, "إحدى المواد غير موجودة")
        q = Quote(created_by_id=user.id)
        for item in payload.items:
            p = found[item.product_id]
            q.items.append(QuoteLine(original_product_id=p.id, product_name=p.name, description=p.description, manufacture=p.manufacture, quantity=item.quantity, unit_price=p.sale_price, image_name=p.image_name))
        db.add(q)
        db.commit()
        db.refresh(q)
        return quote_dict(q)

    # Serve exactly the locally bundled web client; no external CDN required.
    @app.get("/")
    def home():
        return FileResponse(HERE / "web" / "index.html", headers={"Cache-Control": "no-cache"})

    app.mount("/assets", StaticFiles(directory=HERE / "web" / "assets"), name="assets")
    app.mount("/web", StaticFiles(directory=HERE / "web"), name="web")
    return app


app = create_app()
