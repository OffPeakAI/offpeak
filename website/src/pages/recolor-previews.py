"""Apply OFFPEAK's approved materials after running generate-previews.py.

This idempotent palette pass preserves all existing geometry, labels and text
coordinates. It only edits paint attributes and adds shared paint definitions.
"""
from pathlib import Path
from lxml import etree

ROOT = Path(__file__).resolve().parent / 'template-previews'
NS = 'http://www.w3.org/2000/svg'

PRIMARY = {
    '#fff', '#ffffff', '#f5f8ed', '#f5f9e9', '#f6f9ee', '#f7faee',
    '#f9fcef', '#fbfdec', '#fbfdee', '#fbffed', '#fcffed', '#fcffef',
    '#fcfff0', '#fcfff1',
}
BACKPLATES = {'#f3f5ed', '#f4f6ef', '#f7f9f2', '#fbfcf8'}
PRIMARY_TEXT = {
    '#464f3b', '#48533a', '#4b553d', '#4c5740', '#4d5542', '#4d5640',
    '#61704b', '#67705c', '#697554', '#6d795b',
}
SECONDARY_TEXT = {'#939d84', '#99a18d'}
EDGES = {'#dce7c8', '#e1e7d6', '#e3e7dc', '#e3ebd2', '#e4e8dc'}
CONNECTORS = {'#b7c4a0', '#c2ccad', '#d3dac6'}


def gradient(defs, identifier, stops):
    if defs.find(f'{{{NS}}}linearGradient[@id="{identifier}"]') is not None:
        return
    node = etree.SubElement(defs, f'{{{NS}}}linearGradient', {
        'id': identifier, 'x1': '0', 'y1': '0', 'x2': '.3', 'y2': '1',
    })
    for offset, color in stops:
        etree.SubElement(node, f'{{{NS}}}stop', {
            'offset': offset, 'stop-color': color,
        })


def recolor(path):
    tree = etree.parse(str(path))
    root = tree.getroot()
    # These are the invariants of the palette-only task, checked on every run.
    original_text = [node.text for node in root.iter(f'{{{NS}}}text')]
    geometry = {
        node: {key: value for key, value in node.attrib.items() if key not in {
            'fill', 'stroke', 'stroke-opacity', 'fill-opacity', 'flood-color', 'flood-opacity',
        }}
        for node in root.iter()
    }
    defs = root.find(f'{{{NS}}}defs')
    gradient(defs, 'workflow-metal', [
        ('0', '#646b60'), ('.47', '#41473b'), ('1', '#2c3228'),
    ])
    gradient(defs, 'workflow-recess', [
        ('0', '#474e42'), ('.48', '#333b2e'), ('1', '#262e21'),
    ])

    for node in root.iter():
        fill = node.get('fill', '').lower()
        stroke = node.get('stroke', '').lower()
        if fill in PRIMARY:
            node.set('fill', 'url(#workflow-metal)')
        elif fill in BACKPLATES:
            node.set('fill', 'url(#workflow-recess)')
        elif fill in PRIMARY_TEXT:
            node.set('fill', '#e8eddf')
        elif fill in SECONDARY_TEXT:
            node.set('fill', '#aab89a')
        elif fill in {'#c4d995', '#cedea4'}:
            node.set('fill', '#CCFF00')
        elif fill == '#eef0e9':
            node.set('fill', '#303532')
        elif fill in {'#edf3df', '#eef4df'}:
            node.set('fill', '#30382a')
        elif fill == '#f7f9f0':
            node.set('fill', '#394132')
        elif fill == '#f0f3e8':
            node.set('fill', '#2c3228')
        elif fill == '#d5e4ae':
            node.set('fill', '#99b35a')
        elif fill == '#e9ede2':
            node.set('fill', '#839076')
        elif fill == '#dbe0d0':
            node.set('fill', '#849372')
            node.set('fill-opacity', '.2')
        if stroke in EDGES:
            node.set('stroke', '#7b856a')
        elif stroke in CONNECTORS:
            node.set('stroke', '#CCFF00')
            node.set('stroke-opacity', '.44')
        if node.get('flood-color', '').lower() == '#344521':
            node.set('flood-color', '#050805')
            node.set('flood-opacity', '.22')

    assert original_text == [node.text for node in root.iter(f'{{{NS}}}text')], path.name
    for node, attributes in geometry.items():
        for key, value in attributes.items():
            assert node.get(key) == value, f'{path.name}: changed geometry {key}'
    path.write_bytes(etree.tostring(root, encoding='UTF-8') + b'\n')
    # Parsing the completed file verifies namespace and XML integrity.
    etree.parse(str(path))
    return path.name


if __name__ == '__main__':
    files = sorted(ROOT.glob('*.svg'))
    assert len(files) == 18, f'Expected 18 workflow SVGs, found {len(files)}'
    for file in files:
        print(recolor(file))
    print('Validated 18 SVGs; all existing geometry and wording preserved.')
