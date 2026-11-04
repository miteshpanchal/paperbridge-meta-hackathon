"""JSON subprocess entry point; never emits source data to logs."""
import json
import sys
from contextlib import redirect_stdout

try:
    # Dependency diagnostics must not corrupt the JSON subprocess protocol.
    with redirect_stdout(sys.stderr):
        from PIL import Image
        from document_media import run
        Image.MAX_IMAGE_PIXELS = 24_000_000
        result = run(json.load(sys.stdin))
    exit_code = 0
except Exception as error:
    result = {'error': str(error)}
    exit_code = 1
print(json.dumps(result))
sys.exit(exit_code)
