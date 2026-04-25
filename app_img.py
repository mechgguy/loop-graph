import dash
from dash import dcc, html, Input, Output, State, dash_table
import plotly.graph_objects as go
import pandas as pd
import numpy as np
import base64
import io

app = dash.Dash(__name__)

# --- Configuration & Mapping ---
STRAND_MAP = {0: 'Blue', 1: 'Red'}
INV_STRAND_MAP = {'Blue': 0, 'Red': 1}
COLORS = {'Blue': '#3498db', 'Red': '#e74c3c'}

initial_data = [
    {'id': 0, 'x': 0.0, 'y': 0.0, 'z': 0.0, 'strand': 'Blue', 'tags': 'start'},
    {'id': 1, 'x': 100.0, 'y': 0.0, 'z': 5.0, 'strand': 'Blue', 'tags': ''},
    {'id': 2, 'x': 200.0, 'y': 50.0, 'z': 2.0, 'strand': 'Red', 'tags': 'end'},
]

def get_figs(df, drag_enabled):
    """Generates synchronized views. drag_enabled toggles the Top View mode."""
    if df.empty: return [go.Figure()] * 3
    
    for col in ['x', 'y', 'z']:
        df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)

    # Side View Calculation
    dists = [0]
    for i in range(1, len(df)):
        p1, p2 = df.iloc[i][['x','y']].values, df.iloc[i-1][['x','y']].values
        dists.append(dists[-1] + np.linalg.norm(p1 - p2))
    
    side, top, three_d = go.Figure(), go.Figure(), go.Figure()
    
    for s_name, color in COLORS.items():
        mask = df['strand'] == s_name
        if mask.any():
            d = 'solid' if s_name == 'Blue' else 'dash'
            side.add_trace(go.Scatter(x=np.array(dists)[mask], y=df[mask]['z'], name=s_name, mode='lines+markers', line=dict(color=color, dash=d)))
            
            top.add_trace(go.Scatter(
                x=df[mask]['x'], y=df[mask]['y'], name=s_name, mode='lines+markers',
                line=dict(color=color, dash=d), marker=dict(size=14, color=color),
                customdata=df[mask]['id']
            ))
            
            three_d.add_trace(go.Scatter3d(x=df[mask]['x'], y=df[mask]['y'], z=df[mask]['z'], name=s_name, mode='lines+markers', line=dict(color=color, width=5)))

    # Top View logic: 'drawpoint' allows node dragging, 'pan' allows moving the camera
    # current_dragmode = 'drawpoint' if drag_enabled else 'pan'
    current_dragmode = 'pan'
    
    side.update_layout(title="SIDE VIEW (Elevation)", height=280, margin=dict(t=30, b=30))
    # top.update_layout(
    #     title=f"TOP VIEW ({'DRAG MODE ON' if drag_enabled else 'PAN MODE'})", 
    #     height=280, margin=dict(t=30, b=30), 
    #     dragmode=current_dragmode
    # )
    top.update_layout(
        # We use title to show status, but keep dragmode standard
        title=f"TOP VIEW ({'DRAG ENABLED' if drag_enabled else 'VIEW MODE'})", 
        height=280, 
        margin=dict(t=30, b=30), 
        dragmode=current_dragmode
    )

    three_d.update_layout(title="3D PERSPECTIVE", template="plotly_dark", height=580, margin=dict(t=30, b=0))
    
    return side, top, three_d

# --- Layout ---
app.layout = html.Div(style={'backgroundColor': '#f1f2f6', 'fontFamily': 'sans-serif'}, children=[
    dcc.Download(id="download-csv"),
    dcc.Store(id='drag-status-store', data=False), # Stores toggle state
    
    html.Div(style={'padding': '15px', 'backgroundColor': '#1e272e', 'display': 'flex', 'gap': '10px', 'alignItems': 'center'}, children=[
        html.H2("CONVEYOR CAD", style={'color': 'white', 'margin': '0 20px 0 0', 'fontSize': '18px'}),
        
        # New Toggle Button
        html.Button('Enable 2D Drag', id='btn-drag-toggle', n_clicks=0, 
                    style={'backgroundColor': '#9b59b6', 'color': 'white', 'border': 'none', 'padding': '10px', 'borderRadius': '4px'}),
        
        dcc.Upload(id='upload-data', children=html.Button('Upload CSV', style={'backgroundColor': '#2ecc71', 'color': 'white', 'border': 'none', 'padding': '10px'})),
        html.Button('+ Add Node', id='btn-add', n_clicks=0, style={'backgroundColor': '#3498db', 'color': 'white', 'padding': '10px'}),
        html.Button('Toggle Group', id='btn-flip', n_clicks=0, style={'backgroundColor': '#f1c40f', 'padding': '10px', 'fontWeight': 'bold'}),
        html.Button('Export CSV', id='btn-save', n_clicks=0, style={'backgroundColor': '#95a5a6', 'color': 'white', 'padding': '10px'}),
        
        html.Div(id='status-msg', style={'color': '#ffa801', 'marginLeft': 'auto', 'fontSize': '14px'})
    ]),

    html.Div(style={'display': 'flex'}, children=[
        html.Div(style={'width': '40%', 'padding': '10px'}, children=[
            dcc.Graph(id='graph-side'),
            dcc.Graph(id='graph-top', config={'editable': True})
        ]),
        html.Div(style={'width': '60%', 'padding': '10px'}, children=[
            dcc.Graph(id='graph-3d')
        ])
    ]),

    html.Div(style={'padding': '0 20px 20px 20px'}, children=[
        dash_table.DataTable(
            id='node-table',
            columns=[{'name': i.upper(), 'id': i} for i in ['id', 'strand', 'x', 'y', 'z', 'tags']],
            data=initial_data,
            editable=True, row_selectable='single', selected_rows=[0],
            style_header={'backgroundColor': '#2f3640', 'color': 'white'},
            style_cell={'textAlign': 'center', 'padding': '8px'}
        )
    ])
])

# --- Logic ---
@app.callback(
    Output('node-table', 'data'),
    Output('graph-side', 'figure'),
    Output('graph-top', 'figure'),
    Output('graph-3d', 'figure'),
    Output('status-msg', 'children'),
    Output('drag-status-store', 'data'),
    Output('btn-drag-toggle', 'style'),
    Output('btn-drag-toggle', 'children'),
    Output('download-csv', 'data'),
    Input('btn-add', 'n_clicks'),
    Input('btn-flip', 'n_clicks'),
    Input('btn-save', 'n_clicks'),
    Input('btn-drag-toggle', 'n_clicks'),
    Input('upload-data', 'contents'),
    Input('graph-top', 'restyleData'),
    Input('node-table', 'data_timestamp'),
    State('upload-data', 'filename'),
    State('node-table', 'data'),
    State('node-table', 'selected_rows'),
    State('drag-status-store', 'data'),
    prevent_initial_call=False
)
def update_editor(add_n, flip_n, save_n, drag_n, upload_content, restyle, ts, filename, table_data, selected_rows, drag_enabled):
    ctx = dash.callback_context
    trigger = ctx.triggered[0]['prop_id'].split('.')[0] if ctx.triggered else None
    df = pd.DataFrame(table_data)
    
    # Toggle Drag Mode logic
    if trigger == 'btn-drag-toggle':
        drag_enabled = not drag_enabled

    # Style for toggle button
    btn_style = {'backgroundColor': '#e67e22' if drag_enabled else '#9b59b6', 'color': 'white', 'border': 'none', 'padding': '10px', 'borderRadius': '4px'}
    btn_text = 'DISABLE DRAG' if drag_enabled else 'ENABLE 2D DRAG'

    if not df.empty:
        for col in ['x', 'y', 'z']:
            df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)

    download_data = dash.no_update
    status = "Ready"

    if trigger == 'graph-top' and restyle and drag_enabled:
        new_coords = restyle[0]
        trace_indices = restyle[1]
        for i, t_idx in enumerate(trace_indices):
            target = 'Blue' if t_idx == 0 else 'Red'
            if 'x' in new_coords: df.loc[df['strand'] == target, 'x'] = new_coords['x'][i]
            if 'y' in new_coords: df.loc[df['strand'] == target, 'y'] = new_coords['y'][i]
        status = "Node moved"

    elif trigger == 'upload-data' and upload_content:
        _, content_string = upload_content.split(',')
        decoded = base64.b64decode(content_string)
        df = pd.read_csv(io.StringIO(decoded.decode('utf-8')))
        if 'group' in df.columns: df = df.rename(columns={'group': 'strand'})
        df['strand'] = df['strand'].map(lambda x: STRAND_MAP.get(x, x))
        status = f"Loaded: {filename}"

    elif trigger == 'btn-add':
        new_id = int(df['id'].max() + 1) if not df.empty else 0
        new_row = {'id': new_id, 'strand': 'Blue', 'x': df.iloc[-1]['x']+50, 'y': 0, 'z': 0, 'tags': ''}
        df = pd.concat([df, pd.DataFrame([new_row])], ignore_index=True)
        status = "Node Added"

    elif trigger == 'btn-flip' and selected_rows:
        df.at[selected_rows[0], 'strand'] = 'Red' if df.at[selected_rows[0], 'strand'] == 'Blue' else 'Blue'
        status = "Group Toggled"

    elif trigger == 'btn-save':
        export_df = df.copy().rename(columns={'strand': 'group'})
        export_df['group'] = export_df['group'].map(lambda x: INV_STRAND_MAP.get(x, x))
        download_data = dcc.send_data_frame(export_df.to_csv, "conveyor_output.csv", index=False)
        status = "Exported"

    side, top, three_d = get_figs(df, drag_enabled)
    return df.to_dict('records'), side, top, three_d, status, drag_enabled, btn_style, btn_text, download_data

if __name__ == '__main__':
    app.run(debug=True)