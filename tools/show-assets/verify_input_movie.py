#!/usr/bin/env python3
"""Read-only checksum and safety inspection for locally downloaded TAS movies.

This tool never launches an emulator or modifies its inputs. A checksum match
only confirms the checksum's byte representation; it does not identify an
exact game revision when the source format is ambiguous.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


MAX_MEMBER_BYTES = 256 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 4096
CODE_SUFFIXES = {
    ".exe", ".dll", ".sys", ".com", ".bat", ".cmd", ".ps1", ".psm1",
    ".sh", ".bash", ".py", ".pyc", ".pyo", ".js", ".mjs", ".cjs",
    ".html", ".htm", ".hta", ".jar", ".class", ".so", ".dylib", ".app",
    ".scr", ".msi", ".apk", ".wasm",
}
EXECUTABLE_MAGICS = (
    b"MZ", b"\x7fELF", b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe", b"PK\x03\x04", b"#!",
)


class UnsafeInput(ValueError):
    pass


def digest_bytes(data: bytes) -> dict[str, str]:
    return {name: hashlib.new(name, data).hexdigest() for name in ("sha256", "sha1", "md5")}


def safe_zip_infos(zf: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    infos = zf.infolist()
    if len(infos) > MAX_ARCHIVE_MEMBERS:
        raise UnsafeInput("archive contains too many members")
    for info in infos:
        name = info.filename.replace("\\", "/")
        path = PurePosixPath(name)
        mode = (info.external_attr >> 16) & 0xFFFF
        if (name.startswith("/") or re.match(r"^[A-Za-z]:", name)
                or any(part == ".." for part in path.parts)
                or stat.S_ISLNK(mode)):
            raise UnsafeInput(f"unsafe archive path or link: {info.filename!r}")
        if info.file_size > MAX_MEMBER_BYTES:
            raise UnsafeInput(f"archive member exceeds size limit: {info.filename!r}")
        if info.file_size and info.compress_size == 0:
            raise UnsafeInput(f"invalid compressed size: {info.filename!r}")
        if info.compress_size and info.file_size / info.compress_size > 1000:
            raise UnsafeInput(f"suspicious compression ratio: {info.filename!r}")
    return infos


def read_zip_member(zf: zipfile.ZipFile, info: zipfile.ZipInfo) -> bytes:
    with zf.open(info, "r") as stream:
        data = stream.read(MAX_MEMBER_BYTES + 1)
    if len(data) > MAX_MEMBER_BYTES or len(data) != info.file_size:
        raise UnsafeInput(f"could not safely read archive member: {info.filename!r}")
    return data


def reject_code_member(name: str, data: bytes) -> None:
    if Path(name).suffix.lower() in CODE_SUFFIXES:
        raise UnsafeInput(f"code or executable member is not accepted: {name!r}")
    magic = EXECUTABLE_MAGICS if Path(name).suffix.lower() != ".bk2" else tuple(m for m in EXECUTABLE_MAGICS if m != b"PK\x03\x04")
    if data.startswith(magic):
        raise UnsafeInput(f"executable or nested archive member is not accepted: {name!r}")


def rom_from_path(path: Path) -> tuple[bytes | None, str | None, str | None]:
    """Return (bytes, archive member, reason). ZIP hashes apply to member bytes."""
    raw = path.read_bytes()
    if not zipfile.is_zipfile(path):
        reject_code_member(path.name, raw)
        return raw, None, None
    try:
        with zipfile.ZipFile(path) as zf:
            infos = safe_zip_infos(zf)
            files = [i for i in infos if not i.is_dir()]
            if len(files) != 1:
                return None, None, "ROM ZIP must contain exactly one file member to select bytes safely"
            info = files[0]
            data = read_zip_member(zf, info)
            reject_code_member(info.filename, data)
            return data, info.filename, None
    except zipfile.BadZipFile as exc:
        return None, None, f"invalid ROM ZIP: {exc}"
    except UnsafeInput as exc:
        return None, None, str(exc)


def rom_hash_candidates(data: bytes) -> dict[str, dict[str, str]]:
    candidates = {"whole_file": digest_bytes(data)}
    if data.startswith(b"MComprHD"):
        return candidates
    # iNES header and optional 512-byte trainer are not cartridge PRG/CHR data.
    if len(data) >= 16 and data[:4] == b"NES\x1a":
        trainer = 512 if data[6] & 0x04 else 0
        offset = 16 + trainer
        if len(data) > offset:
            candidates["ines_payload_after_header_and_trainer"] = digest_bytes(data[offset:])
    return candidates


def first_rom_type(data: bytes) -> str:
    if data.startswith(b"MComprHD"):
        return "chd"
    if data.startswith(b"NES\x1a"):
        return "ines"
    return "raw_file"


def parse_bk2(data: bytes) -> tuple[str | None, str | None, dict[str, str]]:
    try:
        with zipfile.ZipFile(__import__("io").BytesIO(data)) as zf:
            infos = safe_zip_infos(zf)
            for info in infos:
                if info.is_dir():
                    continue
                if Path(info.filename).suffix.lower() in CODE_SUFFIXES:
                    raise UnsafeInput(f"code or executable member is not accepted: {info.filename!r}")
                with zf.open(info) as stream:
                    prefix = stream.read(8)
                magic = EXECUTABLE_MAGICS if Path(info.filename).suffix.lower() != ".bk2" else tuple(m for m in EXECUTABLE_MAGICS if m != b"PK\x03\x04")
                if prefix.startswith(magic):
                    raise UnsafeInput(f"executable or nested archive member is not accepted: {info.filename!r}")
            headers = [i for i in infos if PurePosixPath(i.filename.replace("\\", "/")).name.lower() == "header.txt"]
            if len(headers) != 1:
                return None, "BK2 must contain exactly one Header.txt", {}
            text = read_zip_member(zf, headers[0]).decode("utf-8-sig", errors="replace")
    except (zipfile.BadZipFile, UnsafeInput) as exc:
        return None, f"invalid or unsafe BK2 archive: {exc}", {}
    metadata: dict[str, str] = {}
    expected: dict[str, str] = {}
    for line in text.splitlines():
        match = re.match(r"\s*([^:]+):\s*(.*?)\s*$", line)
        if not match:
            match = re.match(r"\s*(\S+)\s+(.+?)\s*$", line)
        if not match:
            continue
        key, value = match.group(1).strip(), match.group(2).strip()
        metadata[key] = value
        if key.lower() in {"sha1", "sha-1", "rom sha1", "rom sha-1"} and re.fullmatch(r"[0-9a-fA-F]{40}", value):
            expected["sha1"] = value.lower()
        elif key.lower() in {"md5", "md-5", "rom md5", "rom md-5"} and re.fullmatch(r"[0-9a-fA-F]{32}", value):
            expected["md5"] = value.lower()
    return expected or None, None, metadata


def parse_fm2(data: bytes) -> tuple[str | None, str | None]:
    text = data.decode("utf-8-sig", errors="replace")
    for line in text.splitlines():
        match = re.match(r"\s*romChecksum\s+([^\s#]+)", line, re.IGNORECASE)
        if not match:
            continue
        token = match.group(1).strip()
        if re.fullmatch(r"[0-9a-fA-F]{40}", token):
            return token.lower(), "sha1-hex"
        if re.fullmatch(r"[0-9a-fA-F]{32}", token):
            return token.lower(), "md5-hex"
        try:
            decoded = base64.b64decode(token, validate=True)
        except (ValueError, base64.binascii.Error):
            return None, "romChecksum is neither supported hex nor base64"
        if len(decoded) == 20:
            return decoded.hex(), "sha1-base64"
        if len(decoded) == 16:
            return decoded.hex(), "md5-base64"
        return None, f"romChecksum base64 decodes to unsupported {len(decoded)} bytes"
    return None, None


def identify_movie(path: Path) -> tuple[dict[str, Any], bytes | None]:
    raw = path.read_bytes()
    if len(raw) > MAX_MEMBER_BYTES:
        raise UnsafeInput("movie exceeds size limit")
    member: str | None = None
    if zipfile.is_zipfile(path) and path.suffix.lower() != ".bk2":
        with zipfile.ZipFile(path) as zf:
            infos = safe_zip_infos(zf)
            files = [i for i in infos if not i.is_dir()]
            for info in files:
                if Path(info.filename).suffix.lower() in CODE_SUFFIXES:
                    raise UnsafeInput(f"code or executable member is not accepted: {info.filename!r}")
                with zf.open(info) as stream:
                    prefix = stream.read(8)
                magic = EXECUTABLE_MAGICS if Path(info.filename).suffix.lower() != ".bk2" else tuple(m for m in EXECUTABLE_MAGICS if m != b"PK\x03\x04")
                if prefix.startswith(magic):
                    raise UnsafeInput(f"executable or nested archive member is not accepted: {info.filename!r}")
            candidates = [i for i in files if Path(i.filename).suffix.lower() in {".bk2", ".fm2", ".fcm", ".fmv", ".smv", ".pjm", ".vbm"}]
            if len(candidates) != 1:
                raise UnsafeInput("movie ZIP must contain exactly one recognized movie file")
            info = candidates[0]
            movie = read_zip_member(zf, info)
            member = info.filename
            source_format = Path(info.filename).suffix.lower().lstrip(".")
            reject_code_member(info.filename, movie)
    else:
        movie = raw
        source_format = path.suffix.lower().lstrip(".")
        reject_code_member(path.name, movie)
    result: dict[str, Any] = {"format": source_format or "unknown", "archive_member": member}
    expected: dict[str, str] | None = None
    reason: str | None = None
    metadata: dict[str, str] = {}
    if source_format == "bk2":
        expected, reason, metadata = parse_bk2(movie)
    elif source_format == "fm2":
        digest, encoding = parse_fm2(movie)
        if digest and encoding:
            algo = "sha1" if encoding.startswith("sha1") else "md5"
            expected = {algo: digest}
            result["expected_hash_encoding"] = encoding
        else:
            reason = encoding or "FM2 romChecksum was not found"
    elif source_format in {"fcm", "fmv", "smv", "pjm", "vbm"}:
        reason = f"{source_format.upper()} ROM metadata is not parsed because a safe local specification is not available"
    else:
        reason = "movie format is not recognized"
    if metadata:
        keep = {"platform", "gamename", "romfilename", "emuversion", "movieversion"}
        result["metadata"] = {
            k: value for k, value in metadata.items()
            if re.sub(r"[^a-z0-9]", "", k.lower()) in keep
        }
    result["expected_rom_hashes"] = expected
    result["expected_rom_hash"] = expected if expected and len(expected) == 1 else None
    result["reason"] = reason
    return result, movie


def verify(movie_path: Path, rom_path: Path) -> dict[str, Any]:
    report: dict[str, Any] = {
        "schema": "tas-input-movie-verification/v1",
        "movie": {"path": os.fspath(movie_path), "sha256": None, "format": None, "archive_member": None,
                  "expected_rom_hashes": None, "expected_rom_hash": None},
        "rom": {"path": os.fspath(rom_path), "sha256": None, "sha1": None, "md5": None,
                "representation": None, "archive_member": None},
        "status": "unverifiable",
        "approved_for_playback": False,
        "matched": False,
        "reason": None,
    }
    try:
        movie_info, movie_bytes = identify_movie(movie_path)
        report["movie"].update(movie_info)
        if movie_bytes is not None:
            report["movie"]["sha256"] = hashlib.sha256(movie_bytes).hexdigest()
        rom_bytes, rom_member, rom_error = rom_from_path(rom_path)
        report["rom"]["archive_member"] = rom_member
        if rom_error:
            report["reason"] = rom_error
            return report
        assert rom_bytes is not None
        hashes = digest_bytes(rom_bytes)
        report["rom"].update(hashes)
        report["rom"]["representation"] = first_rom_type(rom_bytes)
        if rom_bytes.startswith(b"MComprHD"):
            report["reason"] = "CHD/disc content is unverifiable: movie and supplied image may hash different track representations"
            return report
        expected = report["movie"].get("expected_rom_hashes")
        if not expected:
            report["reason"] = report["movie"].get("reason") or "movie does not provide a supported expected ROM hash"
            return report
        candidates = rom_hash_candidates(rom_bytes)
        matches: list[tuple[str, str]] = []
        for algorithm, expected_hex in expected.items():
            for representation, values in candidates.items():
                if values[algorithm] == expected_hex:
                    matches.append((algorithm, representation))
        if matches:
            unique_representations = sorted({repr_name for _, repr_name in matches})
            report["status"] = "matched"
            report["matched"] = True
            report["matched_hashes"] = [{"algorithm": algo, "representation": rep} for algo, rep in matches]
            report["reason"] = "expected movie checksum matches supplied ROM bytes in the listed representation; this does not establish an exact game revision"
            report["approved_for_playback"] = True
            if len(unique_representations) > 1:
                report["approved_for_playback"] = False
                report["reason"] = "checksum matches multiple ROM byte representations; exact representation is ambiguous"
            return report
        report["status"] = "mismatch"
        report["reason"] = "movie provides an expected ROM checksum, but it matches none of the supported supplied-ROM representations"
        return report
    except FileNotFoundError as exc:
        report["reason"] = f"input not found: {exc.filename}"
    except (OSError, UnsafeInput, zipfile.BadZipFile) as exc:
        report["reason"] = str(exc)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--movie", required=True, type=Path, help="local BK2, FM2, or safely wrapped movie file")
    parser.add_argument("--rom", required=True, type=Path, help="local ROM file or a ZIP containing exactly one ROM member")
    parser.add_argument("--out", type=Path, help="write JSON report to this path; stdout when omitted")
    args = parser.parse_args(argv)
    report = verify(args.movie, args.rom)
    output = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(output, encoding="utf-8")
    else:
        sys.stdout.write(output)
    return 0 if report["approved_for_playback"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
