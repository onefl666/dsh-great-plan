#!/usr/bin/env python3
"""Convert the pinned interactive-swe parquet file to JSONL on stdout.

The harness is Node-only; this script is the one optional Python helper. It is
run through `uv run --with pyarrow` (or a Python that already has pyarrow).
"""
import json
import sys

import pyarrow.parquet as pq


def main() -> int:
    if len(sys.argv) != 2:
        print('usage: parquet-to-jsonl.py <file.parquet>', file=sys.stderr)
        return 2
    table = pq.read_table(sys.argv[1])
    for row in table.to_pylist():
        print(json.dumps(row, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
