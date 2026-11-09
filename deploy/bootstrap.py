#!/usr/bin/env python3
"""Create local deployment secrets without printing them or overwriting existing files."""
import argparse
import base64
import os
from pathlib import Path
import re
import secrets

parser = argparse.ArgumentParser()
parser.add_argument("--domain", required=True, help="Public HTTPS hostname")
args = parser.parse_args()
if not re.fullmatch(r"(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}", args.domain):
    parser.error("Provide a DNS hostname without scheme, path or port")
root = Path(__file__).resolve().parent.parent
directory = root / ".secrets"
os.umask(0o077)
directory.mkdir(mode=0o700, exist_ok=True)
if directory.is_symlink():
    raise SystemExit("Secrets directory must not be a symlink")
directory.chmod(0o700)
if any(directory.iterdir()) or (root / ".env").exists():
    raise SystemExit("Existing secrets or .env found; refusing to overwrite. Back up before rotation.")
app_password = secrets.token_hex(32)
totp = base64.b32encode(secrets.token_bytes(20)).decode()
values = {
    "db_admin_password": secrets.token_hex(32),
    "db_app_password": app_password,
    "database_url": f"postgres://blink:{app_password}@postgres:5432/blink",
    "encryption_key": secrets.token_hex(32),
    "admin_password": secrets.token_urlsafe(24),
    "admin_totp": totp,
    "admin_totp_uri": f"otpauth://totp/Blink%20Node:admin?secret={totp}&issuer=Blink%20Node&digits=6&period=30",
}
for name, value in values.items():
    path = directory / name
    path.write_text(value + "\n")
    # Compose file secrets are bind mounts and preserve host UID/mode. The
    # private parent directory prevents other host users from accessing files;
    # mounted files must be readable by the non-root container identities.
    path.chmod(0o444 if name != "admin_totp_uri" else 0o600)
(root / ".env").write_text(f"BLINK_DOMAIN={args.domain.lower()}\nADMIN_USERNAME=admin\n")
print("Created .env and private .secrets/ directory (0700); Compose secrets are read-only. No secrets printed.")
print("Read .secrets/admin_password locally; import .secrets/admin_totp_uri into an authenticator.")
print("Keep the password, authenticator and encrypted offline backup separate.")
