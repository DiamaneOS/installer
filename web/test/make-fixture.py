#!/usr/bin/env python3
"""Write the test image sets, with flash-all.sh and the expected steps from the tools.

fixture/ must never be locked. fixture-relock/ installs an AVB key and stops in
the bootloader for the lock. Run it again after flash_all.py in diamaneos-tools changes:
    python3 -B web/test/make-fixture.py ~/path/to/diamaneos-tools
"""
import hashlib
import json
import pathlib
import shutil
import struct
import subprocess
import sys

TOOLS = pathlib.Path(sys.argv[1]).resolve()
sys.path.insert(0, str(TOOLS / 'src'))
from diamaneos_tools import flash_all  # noqa: E402

TEST = pathlib.Path(__file__).resolve().parent
FIRMWARE = [('abl_a', 'abl.elf'), ('abl_b', 'abl.elf'), ('logfs', 'logfs_ufs_8mb.bin'), ('storsec', 'storsec.mbn')]
IMAGES = ['abl.elf', 'logfs_ufs_8mb.bin', 'storsec.mbn', 'modemst1.img', 'modemst2.img', 'boot.img',
          'super.img', 'system.img', 'vendor.img', 'frp.img', 'metadata.img', 'misc.img', 'userdata.img']
KEY = b'fixture AVB public key\n'


def vbmeta(key):
    """A vbmeta header (avb_vbmeta_image.h) whose auxiliary block holds the public key."""
    auth, key_offset = 64, 64
    aux = bytes(key_offset) + key + bytes(-(key_offset + len(key)) % 64)
    header = struct.pack('>4sII', b'AVB0', 1, 0) + struct.pack('>QQ', auth, len(aux)) + bytes(4)
    header += struct.pack('>QQQQQQ', 0, 0, 0, 0, key_offset, len(key))
    return header + bytes(256 - len(header)) + bytes(auth) + aux


def write(out, extra, files):
    if out.exists():
        shutil.rmtree(out)
    out.mkdir()
    sums = {}
    for name, data in files.items():
        (out / name).write_bytes(data)
        sums[name] = hashlib.sha256(data).hexdigest()
    entry = lambda name: {'file': name, 'sha256': sums[name]}  # noqa: E731
    record = {
        'schema_version': 1, 'build_id': 'fixture', 'product': 'FP6', 'release': False,
        'flash': {'slot': 'a', 'bootloader': ['boot', 'vbmeta'], 'logical': ['system', 'vendor']},
        'wipe': {'images': {name: entry(f'{name}.img') for name in ('userdata', 'metadata', 'frp', 'misc')}},
        'firmware': {
            'release': 'FP6.QREL.16.111.0',
            'steps': [dict({'partition': p, 'image': i}, **({'wipe_only': True} if p == 'logfs' else {}))
                      for p, i in FIRMWARE],
            'reset': {name: entry(f'{name}.img') for name in ('modemst1', 'modemst2')},
            'images': {i: sums[i] for _, i in FIRMWARE},
        },
        **extra,
    }
    # As build package writes it, and the scripts from the record as it reads back.
    (out / 'build.json').write_text(json.dumps(record, sort_keys=True, indent=2) + '\n')
    record = json.loads((out / 'build.json').read_text())
    for name, text in flash_all.scripts(record).items():
        (out / name).write_text(text)
    lines = [f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}' for p in sorted(out.iterdir())]
    (out / 'SHA256SUMS').write_text('\n'.join(lines) + '\n')
    return flash_all.commands(record)


def main():
    images = {name: f'fixture {name}\n'.encode() for name in IMAGES}
    commit = subprocess.run(['git', '-C', str(TOOLS), 'rev-parse', 'HEAD'], capture_output=True, text=True,
                            check=True).stdout.strip()
    expected = {
        'tools': commit,
        'fixture': write(TEST / 'fixture', {
            'signing': 'public-test-keys', 'never_lock': True,
            'notice': 'Test build signed with public test keys. Keep the bootloader unlocked.',
        }, {**images, 'vbmeta.img': b'fixture vbmeta.img\n'}),
        'fixture-relock': write(TEST / 'fixture-relock', {
            'never_lock': False, 'avb_custom_key': {'file': 'avb_pkmd.bin'},
        }, {**images, 'vbmeta.img': vbmeta(KEY), 'avb_pkmd.bin': KEY}),
    }
    # One command per line, so a change shows up as a short diff.
    text = ',\n'.join(f'  {json.dumps(key)}: ' + (json.dumps(value) if key == 'tools' else
                       '[\n' + ',\n'.join('    ' + json.dumps(c) for c in value) + '\n  ]')
                       for key, value in expected.items())
    (TEST / 'flash-all-commands.json').write_text('{\n' + text + '\n}\n')


if __name__ == '__main__':
    main()
