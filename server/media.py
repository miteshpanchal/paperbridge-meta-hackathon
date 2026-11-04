"""JSON subprocess entry point; never emits source data to logs."""
import json
import sys
from PIL import Image
from document_media import run

Image.MAX_IMAGE_PIXELS = 24_000_000

try:
    print(json.dumps(run(json.load(sys.stdin))))
except Exception as error:
    print(json.dumps({'error': str(error)}))
    sys.exit(1)
