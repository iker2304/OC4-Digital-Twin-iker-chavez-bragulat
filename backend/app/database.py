import json
import os
from typing import Optional, List
from datetime import datetime
from .models.user import UserInDB, UserCreate, DigitalTwinProfile
from .auth import get_password_hash, verify_password, create_password_reset_token

DB_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "db")
os.makedirs(DB_DIR, exist_ok=True)

USERS_DB_PATH = os.path.join(DB_DIR, "users.json")

def _load_users() -> List[dict]:
    if os.path.exists(USERS_DB_PATH):
        try:
            with open(USERS_DB_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []
    return []

def _save_users(users: List[dict]) -> None:
    with open(USERS_DB_PATH, "w", encoding="utf-8") as f:
        json.dump(users, f, default=str)

def _user_to_dict(user: UserInDB) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "username": user.username,
        "full_name": user.full_name,
        "phone": user.phone,
        "hashed_password": user.hashed_password,
        "salt": user.salt,
        "is_active": user.is_active,
        "is_verified": user.is_verified,
        "twin_profile": {
            "twin_id": user.twin_profile.twin_id,
            "name": user.twin_profile.name,
            "description": user.twin_profile.description,
            "configuration": user.twin_profile.configuration,
            "preferences": user.twin_profile.preferences,
            "created_at": user.twin_profile.created_at.isoformat() if user.twin_profile.created_at else None,
            "updated_at": user.twin_profile.updated_at.isoformat() if user.twin_profile.updated_at else None,
        },
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "updated_at": user.updated_at.isoformat() if user.updated_at else None,
        "last_login": user.last_login.isoformat() if user.last_login else None,
        "password_reset_token": user.password_reset_token,
        "password_reset_expires": user.password_reset_expires.isoformat() if user.password_reset_expires else None,
    }

def _dict_to_user(data: dict) -> UserInDB:
    twin_profile_data = data.get("twin_profile", {})
    return UserInDB(
        id=data.get("id"),
        email=data.get("email"),
        username=data.get("username"),
        full_name=data.get("full_name", ""),
        phone=data.get("phone", ""),
        hashed_password=data.get("hashed_password"),
        salt=data.get("salt"),
        is_active=data.get("is_active", True),
        is_verified=data.get("is_verified", False),
        twin_profile=DigitalTwinProfile(
            twin_id=twin_profile_data.get("twin_id"),
            name=twin_profile_data.get("name", ""),
            description=twin_profile_data.get("description", ""),
            configuration=twin_profile_data.get("configuration", {}),
            preferences=twin_profile_data.get("preferences", {}),
            created_at=datetime.fromisoformat(twin_profile_data["created_at"]) if twin_profile_data.get("created_at") else datetime.utcnow(),
            updated_at=datetime.fromisoformat(twin_profile_data["updated_at"]) if twin_profile_data.get("updated_at") else datetime.utcnow(),
        ),
        created_at=datetime.fromisoformat(data["created_at"]) if data.get("created_at") else datetime.utcnow(),
        updated_at=datetime.fromisoformat(data["updated_at"]) if data.get("updated_at") else datetime.utcnow(),
        last_login=datetime.fromisoformat(data["last_login"]) if data.get("last_login") else None,
        password_reset_token=data.get("password_reset_token"),
        password_reset_expires=datetime.fromisoformat(data["password_reset_expires"]) if data.get("password_reset_expires") else None,
    )

def get_user_by_email(email: str) -> Optional[UserInDB]:
    users = _load_users()
    for user_data in users:
        if user_data.get("email", "").lower() == email.lower():
            return _dict_to_user(user_data)
    return None

def get_user_by_id(user_id: str) -> Optional[UserInDB]:
    users = _load_users()
    for user_data in users:
        if user_data.get("id") == user_id:
            return _dict_to_user(user_data)
    return None

def get_user_by_username(username: str) -> Optional[UserInDB]:
    users = _load_users()
    for user_data in users:
        if user_data.get("username", "").lower() == username.lower():
            return _dict_to_user(user_data)
    return None

def create_user(user_create: UserCreate) -> Optional[UserInDB]:
    if get_user_by_email(user_create.email):
        return None
    if get_user_by_username(user_create.username):
        return None

    hashed_password = get_password_hash(user_create.password)

    twin_profile = user_create.twin_profile if user_create.twin_profile else DigitalTwinProfile()

    user = UserInDB(
        email=user_create.email,
        username=user_create.username,
        full_name=user_create.full_name or "",
        phone=user_create.phone or "",
        hashed_password=hashed_password,
        twin_profile=twin_profile,
    )

    users = _load_users()
    users.append(_user_to_dict(user))
    _save_users(users)

    return user

def authenticate_user(email: str, password: str) -> Optional[UserInDB]:
    user = get_user_by_email(email)
    if not user:
        return None
    if not verify_password(password, user.hashed_password):
        return None
    return user

def update_user(user_id: str, update_data: dict) -> Optional[UserInDB]:
    users = _load_users()
    for i, user_data in enumerate(users):
        if user_data.get("id") == user_id:
            for key, value in update_data.items():
                if value is not None and key != "id":
                    if key == "twin_profile":
                        twin_data = user_data.get("twin_profile", {})
                        for twin_key, twin_value in value.items():
                            if twin_value is not None:
                                twin_data[twin_key] = twin_value
                        twin_data["updated_at"] = datetime.utcnow().isoformat()
                        user_data["twin_profile"] = twin_data
                    elif key == "hashed_password":
                        pass
                    else:
                        user_data[key] = value
            user_data["updated_at"] = datetime.utcnow().isoformat()
            users[i] = user_data
            _save_users(users)
            return _dict_to_user(user_data)
    return None

def update_last_login(user_id: str) -> None:
    users = _load_users()
    for i, user_data in enumerate(users):
        if user_data.get("id") == user_id:
            user_data["last_login"] = datetime.utcnow().isoformat()
            users[i] = user_data
            _save_users(users)
            return

def set_password_reset_token(email: str) -> Optional[str]:
    user = get_user_by_email(email)
    if not user:
        return None

    token = create_password_reset_token(email)
    users = _load_users()
    for i, user_data in enumerate(users):
        if user_data.get("id") == user.id:
            user_data["password_reset_token"] = token
            user_data["password_reset_expires"] = (datetime.utcnow().replace(microsecond=0)).isoformat()
            users[i] = user_data
            _save_users(users)
            return token
    return None

def reset_password(token: str, new_password: str) -> bool:
    users = _load_users()
    for i, user_data in enumerate(users):
        if user_data.get("password_reset_token") == token:
            expires = datetime.fromisoformat(user_data["password_reset_expires"]) if user_data.get("password_reset_expires") else None
            if expires and datetime.utcnow() > expires:
                return False
            user_data["hashed_password"] = get_password_hash(new_password)
            user_data["password_reset_token"] = None
            user_data["password_reset_expires"] = None
            user_data["updated_at"] = datetime.utcnow().isoformat()
            users[i] = user_data
            _save_users(users)
            return True
    return False

def delete_user(user_id: str) -> bool:
    users = _load_users()
    for i, user_data in enumerate(users):
        if user_data.get("id") == user_id:
            users.pop(i)
            _save_users(users)
            return True
    return False
