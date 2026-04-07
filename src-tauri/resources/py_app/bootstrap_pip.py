"""
Bootstrap pip into the active interpreter (the app venv) when ensurepip is missing
or insufficient — common with python-build-standalone install_only_stripped.
Requires network once to fetch get-pip.py from PyPA.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import urllib.request

GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"


def main() -> int:
    fd, path = tempfile.mkstemp(suffix="-get-pip.py")
    os.close(fd)
    try:
        urllib.request.urlretrieve(GET_PIP_URL, path)
        subprocess.check_call([sys.executable, path, "--no-warn-script-location"])
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
