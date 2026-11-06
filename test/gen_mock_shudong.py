"""严格复刻 Android BootstrapCrypto.makeEnvelope 的加密格式，生成一份模拟 .shudong。
仅用于验证 Obsidian 插件端 decryptEnvelope 能解开「手机端格式」——不依赖真实手机。
格式：JSON { v=1, alg, salt(b64), iv(b64), ct(b64=密文‖tag), hint }
"""
import os, json, base64, secrets
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ITER = 20000
PASS = "K7M2P9"            # 模拟一次性口令
EMAIL = "user@example.com"
IMAP_HOST = "imap.qq.com"
AUTH = "EXAMPLE_AUTH_CODE"  # 模拟授权码（仅用于自测，非真实凭据）

salt = secrets.token_bytes(16)
kdf = PBKDF2HMAC(algorithm=hashes.SHA1(), length=32, salt=salt, iterations=ITER)
key = kdf.derive(PASS.encode())

inner = json.dumps({"email": EMAIL, "imapHost": IMAP_HOST, "authCode": AUTH})
iv = secrets.token_bytes(12)
ct_and_tag = AESGCM(key).encrypt(iv, inner.encode("utf-8"), None)  # 返回 密文‖tag

env = {
    "v": 1,
    "alg": "PBKDF2-HMAC-SHA1/AES-256-GCM",
    "salt": base64.b64encode(salt).decode(),
    "iv": base64.b64encode(iv).decode(),
    "ct": base64.b64encode(ct_and_tag).decode(),
    "hint": "树洞日记引导配置",
}

here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, "mock_device.shudong")
with open(out, "w", encoding="utf-8") as f:
    json.dump(env, f, ensure_ascii=False)
print("已生成模拟手机端 .shudong：", out)
print("一次性口令（演示用）：", PASS)
