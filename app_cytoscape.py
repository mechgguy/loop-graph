import dash
from dash import html, dcc, Input, Output, State
import dash_cytoscape as cyto

app = dash.Dash(__name__)

# Simplified Groups
GROUPS = {
    'Blue': '#3498db',
    'Red': '#e74c3c'
}

initial_elements = [
    {'data': {'id': 'N0', 'label': 'Node 0', 'group': 'Blue'}, 'position': {'x': 100, 'y': 100}, 'classes': 'Blue'},
]

app.layout = html.Div(style={'display': 'flex', 'height': '100vh', 'fontFamily': 'Segoe UI, sans-serif'}, children=[
    # SIDEBAR
    html.Div(style={'width': '350px', 'padding': '25px', 'background': '#1e272e', 'color': 'white', 'boxShadow': '2px 0 5px rgba(0,0,0,0.3)'}, children=[
        html.H2("Node Manager", style={'marginTop': '0'}),
        html.Hr(style={'borderColor': '#485460'}),
        
        # ADD SECTION
        html.H4("Add New Node"),
        dcc.Input(id='input-label', type='text', placeholder='Name...', style={'width': '100%', 'padding': '8px', 'marginBottom': '10px', 'borderRadius': '4px', 'border': 'none'}),
        dcc.Dropdown(
            id='input-group', 
            options=[{'label': k, 'value': k} for k in GROUPS.keys()],
            value='Blue',
            clearable=False,
            style={'color': 'black', 'marginBottom': '10px'}
        ),
        html.Button('Create Node', id='btn-add', n_clicks=0, 
                    style={'width': '100%', 'padding': '10px', 'backgroundColor': '#05c46b', 'color': 'white', 'border': 'none', 'borderRadius': '4px', 'cursor': 'pointer', 'fontWeight': 'bold'}),
        
        html.Hr(style={'borderColor': '#485460', 'margin': '25px 0'}),
        
        # MODIFY SECTION
        html.H4("Modify Selection"),
        html.P("Select a node to flip its color:", style={'fontSize': '13px', 'color': '#d2dae2'}),
        html.Div(style={'display': 'flex', 'gap': '10px'}, children=[
            html.Button('Set Blue', id='btn-blue', n_clicks=0, style={'flex': '1', 'padding': '8px', 'backgroundColor': '#3498db', 'color': 'white', 'border': 'none', 'borderRadius': '4px', 'cursor': 'pointer'}),
            html.Button('Set Red', id='btn-red', n_clicks=0, style={'flex': '1', 'padding': '8px', 'backgroundColor': '#e74c3c', 'color': 'white', 'border': 'none', 'borderRadius': '4px', 'cursor': 'pointer'}),
        ]),

        html.Hr(style={'borderColor': '#485460', 'margin': '25px 0'}),
        html.H4("Coordinates List"),
        html.Div(id='coord-display', style={'maxHeight': '30vh', 'overflowY': 'auto', 'background': '#2f3542', 'padding': '10px', 'borderRadius': '4px'})
    ]),
    
    # CANVAS
    cyto.Cytoscape(
        id='cytoscape-canvas',
        layout={'name': 'preset'},
        style={'width': '100%', 'height': '100%', 'backgroundColor': '#f1f2f6'},
        elements=initial_elements,
        stylesheet=[
            {'selector': 'node', 'style': {'label': 'data(label)', 'width': 30, 'height': 30, 'fontSize': '12px'}},
            {'selector': '.Blue', 'style': {'background-color': GROUPS['Blue']}},
            {'selector': '.Red', 'style': {'background-color': GROUPS['Red']}},
            {'selector': 'node:selected', 'style': {'border-width': 5, 'border-color': '#ffa801', 'width': 35, 'height': 35}}
        ]
    )
])

@app.callback(
    Output('cytoscape-canvas', 'elements'),
    Output('coord-display', 'children'),
    Input('btn-add', 'n_clicks'),
    Input('btn-blue', 'n_clicks'),
    Input('btn-red', 'n_clicks'),
    Input('cytoscape-canvas', 'elements'),
    State('cytoscape-canvas', 'selectedNodeData'),
    State('input-label', 'value'),
    State('input-group', 'value'),
    prevent_initial_call=True
)
def handle_updates(add_n, blue_n, red_n, elements, selected, label, group):
    ctx = dash.callback_context
    trigger = ctx.triggered[0]['prop_id'].split('.')[0]

    # Add Node logic
    if trigger == 'btn-add' and label:
        elements.append({
            'data': {'id': label, 'label': label, 'group': group},
            'position': {'x': 200, 'y': 200},
            'classes': group
        })

    # Change Group logic
    elif trigger in ['btn-blue', 'btn-red'] and selected:
        target_group = 'Blue' if trigger == 'btn-blue' else 'Red'
        selected_id = selected[0]['id']
        for el in elements:
            if el['data'].get('id') == selected_id:
                el['data']['group'] = target_group
                el['classes'] = target_group

    # Update Coordinate Sidebar
    coords = [
        html.Div([
            html.Span("● ", style={'color': GROUPS.get(el['data'].get('group', 'Blue'))}),
            html.B(f"{el['data']['label']}: "), 
            f"{int(el['position']['x'])}, {int(el['position']['y'])}"
        ], style={'marginBottom': '8px', 'fontSize': '13px'})
        for el in elements if 'position' in el
    ]

    return elements, coords

if __name__ == '__main__':
    app.run(debug=True)