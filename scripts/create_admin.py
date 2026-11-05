"""Create the first admin account; no hardcoded default credentials."""
import sys
from pathlib import Path
from getpass import getpass
from sqlalchemy import select
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.main import app
from server.models import User
from server.security import hash_password


def main():
    with app.state.session_factory() as db:
        if db.scalar(select(User).where(User.role == "admin")):
            print("حساب الإدارة موجود بالفعل؛ لن يتم إنشاء حساب ثانٍ تلقائياً.")
            return
        username = input("اسم مستخدم الإدارة (حروف إنجليزية وأرقام): ").strip().lower()
        if len(username) < 3 or not all(c.isalnum() or c in "_.-" for c in username) or not username.isascii():
            raise SystemExit("اسم المستخدم غير صالح")
        full_name = input("اسم المسؤول: ").strip()
        if len(full_name) < 2:
            raise SystemExit("اسم المسؤول قصير")
        password = getpass("كلمة مرور قوية (12 رمزاً على الأقل): ")
        confirm = getpass("أعد كتابة كلمة المرور: ")
        if password != confirm:
            raise SystemExit("كلمتا المرور مختلفتان")
        try:
            password_hash = hash_password(password)
        except ValueError as exc:
            raise SystemExit(str(exc))
        db.add(User(username=username, full_name=full_name, password_hash=password_hash, role="admin", can_view_purchase=True, can_view_sale=True))
        db.commit()
        print("تم إنشاء حساب الإدارة بأمان. لا تُعرض كلمة المرور أو تُحفظ كنص.")

if __name__ == "__main__":
    main()
