"""Document operations on real uploads. Source crops are never redrawn."""
import base64
import io
import re
from pathlib import Path
from xml.sax.saxutils import escape
from PIL import Image, ImageOps

def uri(image):
    image=image.convert('RGB');image.thumbnail((1800,2400))
    stream=io.BytesIO();image.save(stream,format='JPEG',quality=90)
    return 'data:image/jpeg;base64,'+base64.b64encode(stream.getvalue()).decode()

def load(value):
    return ImageOps.exif_transpose(Image.open(io.BytesIO(base64.b64decode(value.split(',',1)[-1],validate=True)))).convert('RGB')

def crop(image,box):
    if not isinstance(box,list) or len(box)!=4:return None
    x1,y1,x2,y2=[max(0,min(1000,float(x))) for x in box]
    if x2<=x1 or y2<=y1:raise ValueError('Invalid crop coordinates')
    w,h=image.size
    return uri(image.crop((int(x1*w/1000),int(y1*h/1000),int(x2*w/1000),int(y2*h/1000))))

def clean_scan(image):
    import cv2
    import numpy as np
    image.thumbnail((1800,2400));source=np.array(image)
    grey=cv2.cvtColor(source,cv2.COLOR_RGB2GRAY)
    edges=cv2.Canny(cv2.GaussianBlur(grey,(5,5),0),35,110)
    contours,_=cv2.findContours(edges,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
    h,w=grey.shape;corrected=False
    for contour in sorted(contours,key=cv2.contourArea,reverse=True)[:30]:
        if not .28<cv2.contourArea(contour)/(w*h)<.98:continue
        quad=cv2.approxPolyDP(contour,.025*cv2.arcLength(contour,True),True)
        if len(quad)!=4 or not cv2.isContourConvex(quad):continue
        points=quad.reshape(4,2).astype('float32')
        sums,diffs=points.sum(axis=1),np.diff(points,axis=1).ravel()
        ordered=np.array([points[sums.argmin()],points[diffs.argmin()],points[sums.argmax()],points[diffs.argmax()]],dtype='float32')
        if len(np.unique(ordered,axis=0))!=4:continue
        a,b,c,d=ordered
        width=int(max(np.linalg.norm(b-a),np.linalg.norm(c-d)))
        height=int(max(np.linalg.norm(d-a),np.linalg.norm(c-b)))
        if min(width,height)<250:continue
        target=np.array([[0,0],[width-1,0],[width-1,height-1],[0,height-1]],dtype='float32')
        source=cv2.warpPerspective(source,cv2.getPerspectiveTransform(ordered,target),(width,height),borderValue=(255,255,255))
        corrected=True;break
    grey=cv2.cvtColor(source,cv2.COLOR_RGB2GRAY)
    lines=cv2.HoughLinesP(cv2.Canny(grey,45,130),1,np.pi/1800,70,minLineLength=max(60,grey.shape[1]//5),maxLineGap=15)
    angles=[]
    if lines is not None:
        for x1,y1,x2,y2 in lines[:,0,:]:
            angle=np.degrees(np.arctan2(y2-y1,x2-x1))
            if abs(angle)<9:angles.append(angle)
    rotation=float(np.median(angles)) if len(angles)>=6 else 0.0
    if .3<abs(rotation)<9:
        rotated=Image.fromarray(source).rotate(rotation,resample=Image.Resampling.BICUBIC,expand=True,fillcolor='white')
        grey=cv2.cvtColor(np.array(rotated),cv2.COLOR_RGB2GRAY)
    else:rotation=0.0
    normalized=cv2.divide(grey,cv2.GaussianBlur(grey,(0,0),25),scale=255)
    result=ImageOps.autocontrast(Image.fromarray(normalized),cutoff=.15).convert('RGB')
    return result,{'perspectiveCorrected':corrected,'rotationDegrees':round(rotation,2),'illuminationNormalized':True,'note':'Conservative correction; curved folds can still need review.'}

def export_pdf(data):
    from reportlab.pdfgen import canvas
    from reportlab.lib.utils import ImageReader
    from reportlab.lib.pagesizes import A4
    from reportlab.platypus import SimpleDocTemplate,Paragraph,Image as PdfImage,Spacer,KeepTogether,Table,TableStyle
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    output=io.BytesIO();paper=data['paper'];warnings=[]
    if data.get('format')=='clean':
        pdf=canvas.Canvas(output,pagesize=A4);pdf.setTitle(paper['name']+' - cleaned source pages')
        for page in paper['pages']:
            image=load(page['image']);width,height=A4
            ratio=min((width-32)/image.width,(height-42)/image.height)
            dw,dh=image.width*ratio,image.height*ratio
            pdf.drawImage(ImageReader(image),(width-dw)/2,(height-dh)/2+8,width=dw,height=dh)
            pdf.setFont('Helvetica',8);pdf.drawString(16,12,'PaperBridge | Source page '+str(page.get('sourcePage',''))+' | Original content preserved')
            pdf.showPage()
        pdf.save()
    else:
        font='Helvetica'
        for path in [Path('C:/Windows/Fonts/arial.ttf'),Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]:
            if path.exists():pdfmetrics.registerFont(TTFont('PaperText',str(path)));font='PaperText';break
        style=ParagraphStyle('Body',fontName=font,fontSize=10.5,leading=16,spaceAfter=8)
        title=ParagraphStyle('Title',parent=style,fontSize=18,leading=23,spaceAfter=18)
        label=ParagraphStyle('Label',parent=style,fontSize=9,textColor='#526447',spaceAfter=7)
        keep=[]
        def inline(text):
            parts=[]
            for piece in re.split(r'(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)',str(text)):
                if piece.startswith('$') and piece.endswith('$'):
                    from matplotlib.mathtext import math_to_image
                    buffer=io.BytesIO();math_to_image('$'+piece.strip('$')+'$',buffer,dpi=160,format='png');buffer.seek(0)
                    im=Image.open(buffer);w,h=im.size
                    ph=min(28,max(12,h*72/160));pw=min(460,w*ph/h)
                    name='data:image/png;base64,'+base64.b64encode(buffer.getvalue()).decode()
                    parts.append('<img src="'+name+'" width="'+str(pw)+'" height="'+str(ph)+'" valign="middle"/>');keep.append(buffer)
                else:parts.append(escape(piece).replace('\n','<br/>'))
            return ''.join(parts)
        story=[Paragraph(escape(paper['name']),title),Paragraph('Digitized from '+str(len(paper['pages']))+' uploaded page(s). Each question is traceable to its source.',label)]
        def flow_image(value,mw=460,mh=180):
            stream=io.BytesIO(base64.b64decode(value.split(',',1)[1]));keep.append(stream)
            im=Image.open(stream);ratio=min(mw/im.width,mh/im.height,1);stream.seek(0)
            return PdfImage(stream,width=im.width*ratio,height=im.height*ratio)
        def add_image(value,mw=460,mh=180):
            story.extend([flow_image(value,mw,mh),Spacer(1,8)])
        for i,q in enumerate(paper['questions']):
            start=len(story)
            story.append(Paragraph('Question '+str(q.get('sourceNumber') or i+1)+' | Source page '+str(q.get('sourcePage') or q.get('page') or ''),label))
            try:text=inline(q['text']);option_texts=[inline(o['text']) for o in q['options']]
            except Exception:
                if q.get('sourceSnippet'):
                    warnings.append('Question '+str(i+1)+': an unsupported formula was preserved as the original source crop.')
                    add_image(q['sourceSnippet'],460,650);story.append(Spacer(1,14));story[start:]=[KeepTogether(story[start:])];continue
                text=escape(q['text']);option_texts=[escape(o['text']) for o in q['options']]
                warnings.append('Question '+str(i+1)+': some LaTeX remains verbatim; review the editable data or original scan.')
            story.append(Paragraph(text,style))
            if q.get('imageUrl'):add_image(q['imageUrl'])
            if len(q['options'])==4 and all(o.get('imageUrl') for o in q['options']):
                cells=[]
                for j,o in enumerate(q['options']):
                    cell=[]
                    if not re.fullmatch(r'\(?\d\)?',o['text'].strip()):cell.append(Paragraph('('+chr(65+j)+') '+option_texts[j],style))
                    cell.append(flow_image(o['imageUrl'],220,110));cells.append(cell)
                table=Table([[cells[0],cells[1]],[cells[2],cells[3]]],colWidths=[250,250])
                table.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),2),('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),10)]))
                story.append(table)
            else:
                for j,o in enumerate(q['options']):
                    story.append(Paragraph('('+chr(65+j)+') '+option_texts[j],style))
                    if o.get('imageUrl'):add_image(o['imageUrl'],220,100)
            story.append(Spacer(1,18))
            story[start:]=[KeepTogether(story[start:])]
        doc=SimpleDocTemplate(output,pagesize=A4,rightMargin=42,leftMargin=42,topMargin=42,bottomMargin=38,title=paper['name'])
        def footer(pdf,doc):
            pdf.setFont('Helvetica',8);pdf.drawString(42,20,'PaperBridge | Digitized uploaded content');pdf.drawRightString(A4[0]-42,20,str(doc.page))
        doc.build(story,onFirstPage=footer,onLaterPages=footer)
    return {'base64':base64.b64encode(output.getvalue()).decode(),'warnings':warnings}

def run(data):
    if data['action']=='export':return export_pdf(data)
    if data['action']=='preview':
        import fitz
        result=export_pdf({'paper':data['paper'],'format':'typeset'})
        doc=fitz.open(stream=base64.b64decode(result['base64']),filetype='pdf')
        pix=doc[0].get_pixmap(matrix=fitz.Matrix(1.25,1.25),alpha=False)
        return {'image':uri(Image.frombytes('RGB',(pix.width,pix.height),pix.samples))}
    if data['action'] in ['pdf','inspect']:
        import fitz
        document=fitz.open(stream=base64.b64decode(data['base64'],validate=True),filetype='pdf')
        if document.needs_pass:raise ValueError('Unlock the PDF before uploading')
        if len(document)<1:raise ValueError('The PDF contains no pages')
        if data['action']=='inspect':
            offset=max(0,int(data.get('offset',0)));previews=[]
            for n in range(offset,min(offset+24,len(document))):
                page=document[n];text=page.get_text();area=max(1,page.rect.width*page.rect.height)
                large_image=any((item['bbox'][2]-item['bbox'][0])*(item['bbox'][3]-item['bbox'][1])/area>.025 for item in page.get_image_info())
                visuals=len(text.strip())<80 or large_image or len(page.get_drawings())>15
                pix=page.get_pixmap(matrix=fitz.Matrix(160/max(page.rect.width,1),160/max(page.rect.width,1)),colorspace=fitz.csRGB,alpha=False)
                previews.append({'sourcePage':n+1,'nativeTextLength':len(text),'hasVisuals':visuals,'thumbnail':uri(Image.frombytes('RGB',(pix.width,pix.height),pix.samples))})
            return {'pageCount':len(document),'previews':previews,'offset':offset,'batchSize':24}
        selected=data.get('pageNumbers')
        if selected is None:selected=list(range(len(document)))
        if not selected or len(selected)>3 or any(type(n) is not int or n<0 or n>=len(document) for n in selected):raise ValueError('Select between one and three valid PDF pages')
        pages,details=[],[]
        for n in selected:
            page=document[n];scale=min(2.2,1800/max(page.rect.width,1),2400/max(page.rect.height,1))
            pix=page.get_pixmap(matrix=fitz.Matrix(scale,scale),colorspace=fitz.csRGB,alpha=False)
            pages.append(uri(Image.frombytes('RGB',(pix.width,pix.height),pix.samples)))
            details.append({'sourcePage':n+1,'nativeText':page.get_text()[:25000],'pageCount':len(document)})
        return {'pages':pages,'pageDetails':details,'pageCount':len(document)}
    image=load(data['image'])
    if data['action']=='regions':return {'images':[crop(image,box) for box in data['regions']]}
    if data['action']=='normalize':
        if data.get('cleanScan'):image,processing=clean_scan(image)
        else:processing={'perspectiveCorrected':False,'rotationDegrees':0,'illuminationNormalized':False,'note':'Native digital page preserved.'}
        return {'image':uri(image),'processing':processing}
    return {'questions':[dict(imageUrl=crop(image,q.get('diagramBox')),sourceSnippet=crop(image,q.get('sourceBox')),options=[crop(image,o.get('imageBox')) for o in q['options']]) for q in data['questions']]}
