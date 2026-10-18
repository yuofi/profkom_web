"""Conservative HTML-to-Markdown adapter; the original guide source is retained."""
import re
from html.parser import HTMLParser
from urllib.parse import urlsplit


def safe_link(value):
    return bool(value and (value.startswith(('/','#')) or urlsplit(value).scheme.lower() in ('http','https','mailto')))

def esc(text):return re.sub(r'([\\`*_[\]])',r'\\\1',text)

class Converter(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out=[];self.stack=[];self.lists=[];self.pre=False;self.skip=0;self.table_cells=0;self.table_header=False;self.in_cell=False
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if tag in ('script','style','iframe','object'):
            self.skip+=1;return
        if self.skip:return
        if tag in ('p','div','section'):self.out.append('\n\n')
        elif tag in ('strong','b'):self.out.append('**')
        elif tag in ('em','i'):self.out.append('*')
        elif tag in ('s','del'):self.out.append('~~')
        elif tag in ('h1','h2','h3','h4','h5','h6'):self.out.append('\n\n'+'#'*int(tag[1])+' ')
        elif tag=='br':self.out.append('  \n')
        elif tag in ('ul','ol'):self.lists.append([tag,0]);self.out.append('\n')
        elif tag=='li':
            if self.lists:self.lists[-1][1]+=1
            bullet=f'{self.lists[-1][1]}. ' if self.lists and self.lists[-1][0]=='ol' else '- '
            self.out.append('\n'+'  '*max(0,len(self.lists)-1)+bullet)
        elif tag=='blockquote':self.out.append('\n\n> ')
        elif tag=='pre':self.pre=True;self.out.append('\n\n```\n')
        elif tag=='code' and not self.pre:self.out.append('`')
        elif tag=='a':
            href=attrs.get('href','');self.stack.append(href if safe_link(href) else None)
            if self.stack[-1]:self.out.append('[')
        elif tag=='img':
            src=attrs.get('src','')
            if safe_link(src):self.out.append('!['+esc(attrs.get('alt',''))+']('+src.replace(' ','%20').replace(')','\\)')+')')
        elif tag=='table':self.table_header=False
        elif tag=='tr':self.table_cells=0;self.out.append('\n| ')
        elif tag in ('td','th'):self.table_cells+=1;self.in_cell=True
    def handle_endtag(self,tag):
        if tag in ('script','style','iframe','object'):
            self.skip=max(0,self.skip-1);return
        if self.skip:return
        if tag in ('p','div','section','h1','h2','h3','h4','h5','h6'):self.out.append('\n\n')
        elif tag in ('strong','b'):self.out.append('**')
        elif tag in ('em','i'):self.out.append('*')
        elif tag in ('s','del'):self.out.append('~~')
        elif tag in ('ul','ol'):
            if self.lists:self.lists.pop()
            self.out.append('\n')
        elif tag=='li':self.out.append('\n')
        elif tag=='blockquote':self.out.append('\n\n')
        elif tag=='code' and not self.pre:self.out.append('`')
        elif tag=='pre':self.pre=False;self.out.append('\n```\n\n')
        elif tag=='a' and self.stack:
            href=self.stack.pop()
            if href:self.out.append(']('+href.replace(' ','%20').replace(')','\\)')+')')
        elif tag in ('td','th'):self.in_cell=False;self.out.append(' | ')
        elif tag=='tr' and not self.table_header:
            self.table_header=True;self.out.append('\n| '+' | '.join(['---']*self.table_cells)+' |')
    def handle_data(self,text):
        if self.skip:return
        if self.in_cell:text=text.replace('\n',' ').replace('|','\\|')
        self.out.append(text if self.pre else esc(text.replace('\xa0',' ')))

def to_markdown(source):
    if not re.search(r'</?(?:p|div|strong|em|b|i|h[1-6]|ul|ol|li|a|img|br|table|pre|blockquote|script)\b',source,re.I):return source
    parser=Converter();parser.feed(source);parser.close()
    return re.sub(r'\n{3,}','\n\n',''.join(parser.out)).strip()
