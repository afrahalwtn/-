"""Session and password controls. No JWT/localStorage or embedded default passwords."""
from __future__ import annotations

from datetime import timedelta
from hashlib import sha256
from hmac import compare_digest, new as new_hmac
from secrets import token_urlsafe
from time import monotonic
from threading import Lock
from argon2 import PasswordHasher, Type, exceptions
from fastapi import HTTPException, Request, Depends
from sqlalchemy import select, delete
from sqlalchemy.orm import Session
from .models import LoginSession, User, now_utc

_password_hasher = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1, hash_len=32, salt_len=16, type=Type.ID)
_cookie = "afrah_session"


def hash_password(pwd: str) -> str:
    if len(pwd) < 12:
        raise ValueError("Password must contain at least 12 characters")
    return _password_hasher.hash(pwd)


def verify_password(pwd: str, stored: str) -> bool:
    try:
        return _password_hasher.verify(stored, pwd)
    except (exceptions.VerifyMismatchError, exceptions.VerificationError, exceptions.InvalidHashError):
        return False


def token_digest(s: str) -> str:
    return sha256(s.encode("utf-8")).hexdigest()


def new_token() -> str:
    return token_urlsafe(48)


def csrf_for_token(secret: bytes, session_token: str) -> str:
    return new_hmac(secret, ("csrf:" + session_token).encode(), "sha256").hexdigest()


def get_db(request: Request):
    with request.app.state.session_factory() as db:
        yield db


def get_session(request: Request, db: Session):
    raw = request.cookies.get(_cookie, "")
    if not raw or len(raw) > 256:
        raise HTTPException(401, "يلزم تسجيل الدخول")
    record = db.get(LoginSession, token_digest(raw))
    now = now_utc()
    if not record:
        raise HTTPException(401, "انتهت الجلسة، سجّل الدخول")
    exp = record.expires_at.replace(tzinfo=record.expires_at.tzinfo or now.tzinfo)
    seen = record.last_seen_at.replace(tzinfo=record.last_seen_at.tzinfo or now.tzinfo)
    if exp <= now or seen < now - timedelta(hours=2):
        db.delete(record)
        db.commit()
        raise HTTPException(401, "انتهت الجلسة، سجّل الدخول")
    user = db.get(User, record.user_id)
    if not user or not user.is_active:
        db.delete(record)
        db.commit()
        raise HTTPException(401, "الحساب غير مفعل")
    if (now - seen).total_seconds() > 60:
        record.last_seen_at = now
        db.commit()
    return user, record, raw


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    return get_session(request, db)[0]


def require_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(403, "هذه العملية للإدارة فقط")
    return user


def csrf_guard(request: Request, db: Session = Depends(get_db)):
    user, session, raw = get_session(request, db)
    given = request.headers.get("x-csrf-token", "")
    expected = csrf_for_token(request.app.state.secret, raw)
    if not given or not compare_digest(given, expected):
        raise HTTPException(403, "فشل التحقق من سلامة الطلب")
    return user


def admin_write(user: User = Depends(csrf_guard)):
    if user.role != "admin":
        raise HTTPException(403, "هذه العملية للإدارة فقط")
    return user


class LoginLimiter:
    """Local single-worker login throttle. Add edge/WAF limits for internet exposure."""
    def __init__(self):
        self._lock = Lock()
        self._entries: dict[str, list[float]] = {}

    def permitted(self, key: str) -> bool:
        with self._lock:
            now = monotonic()
            if len(self._entries) > 20_000:
                self._entries = {k: v for k, v in self._entries.items() if v and v[-1] > now - 900}
            self._entries[key] = [t for t in self._entries.get(key, []) if t > now - 900]
            return len(self._entries[key]) < 5

    def fail(self, key: str):
        with self._lock:
            self._entries.setdefault(key, []).append(monotonic())

    def clear(self, key: str):
        with self._lock:
            self._entries.pop(key, None)
