#!/usr/bin/env python3
"""Ask DogeCloud to fetch a public whatsub release asset server-side."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.parse
import urllib.request


API_BASE = "https://api.dogecloud.com"
FETCH_PATH = "/oss/fetch.json"
QUERY_PATH = "/oss/fetch/query.json"
RELEASE_PATH_PREFIX = "/rjxznb/whatsub-releases/releases/download/"


def build_authorization(
    access_key: str, secret_key: str, request_path: str, body: str
) -> str:
    signature = hmac.new(
        secret_key.encode("utf-8"),
        f"{request_path}\n{body}".encode("utf-8"),
        hashlib.sha1,
    ).hexdigest()
    return f"TOKEN {access_key}:{signature}"


def validate_source_url(source_url: str) -> None:
    parsed = urllib.parse.urlsplit(source_url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "github.com"
        or parsed.username is not None
        or parsed.password is not None
        or not parsed.path.startswith(RELEASE_PATH_PREFIX)
    ):
        raise ValueError("source URL must be a public whatsub release asset")


def fetch_query_path(task_id: str) -> str:
    return f"{QUERY_PATH}?{urllib.parse.urlencode({'id': task_id})}"


def request_api(
    access_key: str,
    secret_key: str,
    request_path: str,
    body: str = "",
) -> dict:
    data = body.encode("utf-8") if body else None
    request = urllib.request.Request(
        API_BASE + request_path,
        data=data,
        method="POST" if data is not None else "GET",
        headers={
            "Authorization": build_authorization(
                access_key, secret_key, request_path, body
            ),
            "Content-Type": "application/json",
            "User-Agent": "whatsub-release-ci/1",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    if result.get("code") != 200:
        raise RuntimeError(
            f"DogeCloud API {request_path} failed: {result.get('msg', 'unknown')}"
        )
    return result.get("data") or {}


def fetch_remote(source_url: str, object_key: str, timeout_secs: int = 1800) -> None:
    validate_source_url(source_url)
    access_key = os.environ["DOGECLOUD_ACCESS_KEY"]
    secret_key = os.environ["DOGECLOUD_SECRET_KEY"]
    bucket = os.environ["DOGECLOUD_BUCKET"]
    body = json.dumps(
        {"url": source_url, "bucket": bucket, "key": object_key},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    task = request_api(access_key, secret_key, FETCH_PATH, body)
    task_id = task.get("id")
    if not task_id:
        raise RuntimeError("DogeCloud fetch response is missing task id")

    print(
        f"DogeCloud fetch queued: {source_url} -> {object_key} "
        f"(wait={task.get('wait')})",
        flush=True,
    )
    deadline = time.monotonic() + timeout_secs
    while time.monotonic() < deadline:
        time.sleep(5)
        status = request_api(
            access_key, secret_key, fetch_query_path(str(task_id))
        )
        if status.get("wait") == -1:
            print(f"DogeCloud fetch processed: {object_key}", flush=True)
            return
    raise TimeoutError(f"DogeCloud fetch timed out: {object_key}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_url")
    parser.add_argument("object_key")
    args = parser.parse_args()
    fetch_remote(args.source_url, args.object_key)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (KeyError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
