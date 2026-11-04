import base64
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
import fitz
from PIL import Image

HELPER = str(Path(__file__).resolve().parents[1] / 'server/media.py')

class MediaTests(unittest.TestCase):
    def call(self, data):
        result = subprocess.run([sys.executable, HELPER], input=json.dumps(data), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_multi_page_pdf_and_source_crops(self):
        doc = fitz.open()
        for n in range(2):
            page = doc.new_page(width=400, height=500)
            page.insert_text((30, 40), 'Authored sample page ' + str(n+1))
            page.draw_rect(fitz.Rect(100, 100, 300, 200))
        pages = self.call({'action': 'pdf', 'base64': base64.b64encode(doc.tobytes()).decode()})['pages']
        self.assertEqual(len(pages), 2)
        result = self.call({'action':'crop','image':pages[0],'questions':[{'diagramBox':[250,200,750,400],'options':[{'imageBox':None}]}]})
        image = Image.open(io.BytesIO(base64.b64decode(result['questions'][0]['imageUrl'].split(',')[1])))
        self.assertAlmostEqual(image.width/image.height, 2.0, places=1)
        self.assertEqual(result['questions'][0]['options'], [None])

    def test_invalid_pdf_does_not_become_a_sample_paper(self):
        result = subprocess.run([sys.executable, HELPER],input=json.dumps({'action':'pdf','base64':'aW52YWxpZA=='}),text=True,capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('error', json.loads(result.stdout))

    def test_large_pdf_has_paginated_local_previews_and_selected_render_limit(self):
        doc=fitz.open()
        for n in range(130):
            page=doc.new_page();page.insert_text((30,40),'Test-only page '+str(n+1))
        value=base64.b64encode(doc.tobytes()).decode()
        result=self.call({'action':'inspect','base64':value,'offset':120})
        self.assertEqual(result['pageCount'],130)
        self.assertEqual(len(result['previews']),10)
        self.assertEqual(result['previews'][-1]['sourcePage'],130)
        rejected=subprocess.run([sys.executable,HELPER],input=json.dumps({'action':'pdf','base64':value,'pageNumbers':[0,1,2,3]}),text=True,capture_output=True)
        self.assertNotEqual(rejected.returncode,0)

if __name__ == '__main__':
    unittest.main()
