#!/usr/bin/env python3
"""Write test/fixture: a small image set whose flash-all.sh comes from the tools.

Run it again after flash_all.py in diamaneos-tools changes:
    python3 web/test/make-fixture.py ~/path/to/diamaneos-tools
"""
import hashlib
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(sys.argv[1]).resolve() / 'src'))
from diamaneos_tools import flash_all  # noqa: E402

OUT = pathlib.Path(__file__).resolve().parent / 'fixture'
FIRMWARE = [('abl_a', 'abl.elf'), ('abl_b', 'abl.elf'), ('logfs', 'logfs_ufs_8mb.bin'), ('storsec', 'storsec.mbn')]
IMAGES = ['abl.elf', 'logfs_ufs_8mb.bin', 'storsec.mbn', 'modemst1.img', 'modemst2.img', 'boot.img', 'vbmeta.img',
          'super.img', 'system.img', 'vendor.img', 'frp.img', 'metadata.img', 'misc.img', 'userdata.img']


def main():
    OUT.mkdir(exist_ok=True)
    sums = {}
    for name in IMAGES:
        data = f'fixture {name}\n'.encode()
        (OUT / name).write_bytes(data)
        sums[name] = hashlib.sha256(data).hexdigest()
    entry = lambda name: {'file': name, 'sha256': sums[name]}  # noqa: E731
    record = {
        'schema_version': 1, 'build_id': 'fixture', 'product': 'FP6', 'release': False,
        'signing': 'public-test-keys', 'never_lock': True,
        'notice': 'Test build signed with public test keys. Keep the bootloader unlocked.',
        'flash': {'slot': 'a', 'bootloader': ['boot', 'vbmeta'], 'logical': ['system', 'vendor']},
        'wipe': {'images': {name: entry(f'{name}.img') for name in ('userdata', 'metadata', 'frp', 'misc')}},
        'firmware': {
            'release': 'FP6.QREL.16.111.0',
            'steps': [dict({'partition': p, 'image': i}, **({'wipe_only': True} if p == 'logfs' else {}))
                      for p, i in FIRMWARE],
            'reset': {name: entry(f'{name}.img') for name in ('modemst1', 'modemst2')},
            'images': {i: sums[i] for _, i in FIRMWARE},
        },
    }
    # As build package writes it, and the scripts from the record as it reads back.
    (OUT / 'build.json').write_text(json.dumps(record, sort_keys=True, indent=2) + '\n')
    record = json.loads((OUT / 'build.json').read_text())
    for name, text in flash_all.scripts(record).items():
        (OUT / name).write_text(text)
    lines = [f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}' for p in sorted(OUT.iterdir())
             if p.name != 'SHA256SUMS']
    (OUT / 'SHA256SUMS').write_text('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
