#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成「加密对齐验证」用的样本密文。

格式必须与 Android 端 com.example.diarymailer.crypto.DiaryCrypto 完全一致：
  KDF : PBKDF2-HMAC-SHA1, salt=b"liuhen_diary_v1", iterations=20000, dklen=32
  算法: AES-256-GCM, IV=12 字节(前缀), tag=16 字节(GCM 标准尾附)
  文本: Base64(NO_WRAP) 的 (IV ‖ 密文 ‖ tag)

本脚本用 cryptography 库按上述格式加密一段已知明文，输出 Base64，
并写 sample.json 供 Node 端独立解密验证（证明 TS 能解开 Android 格式密文）。
"""
import base64
import json
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

SALT = b"liuhen_diary_v1"
ITER = 20000

# 测试用固定授权码与明文（覆盖中文、emoji、换行、井号标签等真实场景）
AUTH_CODE = "TEST_AUTH_123"
PLAINTEXT = "你好，树洞日记测试 🌿\n第二行文字 #周末 #带娃\n--- 分隔 ---"


def derive_key(auth: str) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA1(), length=32, salt=SALT, iterations=ITER)
    return kdf.derive(auth.encode("utf-8"))


def encrypt_bytes(key: bytes, plain: bytes) -> bytes:
    iv = os.urandom(12)
    cipher = Cipher(algorithms.AES(key), modes.GCM(iv))
    enc = cipher.encryptor()
    ct = enc.update(plain) + enc.finalize()
    tag = enc.tag  # 16 字节
    return iv + ct + tag


def decrypt_bytes(key: bytes, data: bytes) -> bytes:
    iv = data[:12]
    rest = data[12:]
    tag = rest[-16:]
    ct = rest[:-16]
    cipher = Cipher(algorithms.AES(key), modes.GCM(iv, tag))
    dec = cipher.decryptor()
    return dec.update(ct) + dec.finalize()


def main():
    key = derive_key(AUTH_CODE)
    ct = encrypt_bytes(key, PLAINTEXT.encode("utf-8"))
    b64 = base64.b64encode(ct).decode("ascii")

    # 自校验：用本脚本 decrypt 能还原明文
    assert decrypt_bytes(key, ct).decode("utf-8") == PLAINTEXT, "自校验失败"

    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "sample.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "authCode": AUTH_CODE,
                "plaintext": PLAINTEXT,
                "b64": b64,
                # 派生密钥十六进制：供 Node 端额外验证「密钥派生」这一步也与 Android 一致
                "keyHex": key.hex(),
            },
            f,
            ensure_ascii=False,
            indent=2,
        )
    print("生成成功，样本已写入 sample.json")
    print("authCode  =", AUTH_CODE)
    print("b64 长度  =", len(b64))
    print("b64 前40  =", b64[:40], "...")


if __name__ == "__main__":
    main()
