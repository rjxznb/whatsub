#!/usr/bin/env python3
"""Upload one release object to DogeCloud using a narrowly-scoped temp token."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import mimetypes
import os
from pathlib import Path
import sys
import urllib.request


TMP_TOKEN_PATH = "/auth/tmp_token.json"


def build_tmp_token_request(
    access_key: str, secret_key: str, bucket: str, object_key: str
) -> tuple[str, str]:
    body = json.dumps(
        {"channel": "OSS_UPLOAD", "scopes": [f"{bucket}:{object_key}"]},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    signature = hmac.new(
        secret_key.encode("utf-8"),
        f"{TMP_TOKEN_PATH}\n{body}".encode("utf-8"),
        hashlib.sha1,
    ).hexdigest()
    return body, f"TOKEN {access_key}:{signature}"


def normalize_domain(domain: str) -> str:
    normalized = domain.rstrip("/")
    if not normalized.startswith("https://"):
        raise ValueError("DOGECLOUD_DOWNLOAD_DOMAIN must use https://")
    return normalized


def request_temp_token(
    access_key: str, secret_key: str, bucket: str, object_key: str
) -> dict:
    body, authorization = build_tmp_token_request(
        access_key, secret_key, bucket, object_key
    )
    request = urllib.request.Request(
        "https://api.dogecloud.com" + TMP_TOKEN_PATH,
        data=body.encode("utf-8"),
        method="POST",
        headers={
            "Authorization": authorization,
            "Content-Type": "application/json",
            "User-Agent": "whatsub-release-ci/1",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    if result.get("code") != 200:
        raise RuntimeError(f"DogeCloud temp-token API failed: {result.get('msg', 'unknown')}")
    data = result.get("data") or {}
    buckets = data.get("Buckets") or []
    if not data.get("Credentials") or not buckets:
        raise RuntimeError("DogeCloud temp-token response is incomplete")
    return {"credentials": data["Credentials"], "bucket": buckets[0]}


def upload_file(
    local_path: Path,
    object_key: str,
    cache_control: str,
    content_type: str | None,
) -> None:
    import boto3
    from botocore.client import Config

    access_key = os.environ["DOGECLOUD_ACCESS_KEY"]
    secret_key = os.environ["DOGECLOUD_SECRET_KEY"]
    bucket = os.environ["DOGECLOUD_BUCKET"]
    normalize_domain(os.environ["DOGECLOUD_DOWNLOAD_DOMAIN"])

    token = request_temp_token(access_key, secret_key, bucket, object_key)
    credentials = token["credentials"]
    bucket_info = token["bucket"]
    s3 = boto3.client(
        "s3",
        aws_access_key_id=credentials["accessKeyId"],
        aws_secret_access_key=credentials["secretAccessKey"],
        aws_session_token=credentials["sessionToken"],
        endpoint_url=bucket_info["s3Endpoint"],
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "virtual"},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )

    extra = {"CacheControl": cache_control}
    guessed_type = content_type or mimetypes.guess_type(local_path.name)[0]
    if guessed_type:
        extra["ContentType"] = guessed_type
    size = local_path.stat().st_size
    print(f"Uploading {local_path.name} -> {object_key} ({size} bytes)", flush=True)
    s3.upload_file(str(local_path), bucket_info["s3Bucket"], object_key, ExtraArgs=extra)
    # OSS_UPLOAD tokens are deliberately write-only; public CDN verification
    # is performed by the workflow after all objects are uploaded.
    print(f"Uploaded {object_key}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("local_path", type=Path)
    parser.add_argument("object_key")
    parser.add_argument("--cache-control", default="public, max-age=31536000, immutable")
    parser.add_argument("--content-type")
    args = parser.parse_args()
    if not args.local_path.is_file():
        parser.error(f"file not found: {args.local_path}")
    upload_file(args.local_path, args.object_key, args.cache_control, args.content_type)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyError as error:
        print(f"Missing required environment variable: {error.args[0]}", file=sys.stderr)
        raise SystemExit(2)
