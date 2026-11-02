import sys, os
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
out = sys.argv[1]
d = Document(); d.add_heading('Linux port check', 0); d.add_paragraph('Hello from the bundled Python.'); d.save(os.path.join(out, 'a.docx'))
w = Workbook(); w.active['A1'] = 'value'; w.active['A2'] = 42; w.save(os.path.join(out, 'b.xlsx'))
p = Presentation(); s = p.slides.add_slide(p.slide_layouts[0]); s.shapes.title.text = 'Linux port check'; p.save(os.path.join(out, 'c.pptx'))
