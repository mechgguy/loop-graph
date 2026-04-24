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

# --- Initial Data (Preserved as requested) ---
initial_data = [
    {'id': 0, 'x': 0.0, 'y': 0.0, 'z': 0.0, 'group': 'Blue', 'tags': 'start'},
    {'id': 1, 'x': 50.0, 'y': 0.0, 'z': 2.0, 'group': 'Blue', 'tags': ''},
    {'id': 2, 'x': 150.0, 'y': 30.0, 'z': 8.0, 'group': 'Blue', 'tags': ''},
]

def get_figs(df):
    if df.empty: return [go.Figure()] * 3
    
    # Side View Calculation (Cumulative distance)
    dists = [0]
    for i in range(1, len(df)):
        dists.append(dists[-1] + np.linalg.norm(df.iloc[i][['x','y']].values - df.iloc[i-1][['x','y']].values))
    
    # Figures Logic
    side, top, three_d = go.Figure(), go.Figure(), go.Figure()
    
    for s_name, color in COLORS.items():
        mask = df['group'] == s_name
        if mask.any():
            d = 'solid' if s_name == 'Blue' else 'dash'
            # Side
            side.add_trace(go.Scatter(x=np.array(dists)[mask], y=df[mask]['z'], name=s_name, mode='lines+markers', line=dict(color=color, dash=d)))
            # Top
            top.add_trace(go.Scatter(x=df[mask]['x'], y=df[mask]['y'], name=s_name, mode='lines+markers', line=dict(color=color, dash=d)))
            # 3D
            three_d.add_trace(go.Scatter3d(x=df[mask]['x'], y=df[mask]['y'], z=df[mask]['z'], name=s_name, mode='lines+markers', line=dict(color=color, width=5)))

    side.update_layout(title="SIDE VIEW (Elevation)", height=280, margin=dict(t=30, b=30))
    top.update_layout(title="TOP VIEW (Plan)", height=280, margin=dict(t=30, b=30))
    three_d.update_layout(title="3D VIEW", template="plotly_dark", height=580, margin=dict(t=30, b=0))
    
    return side, top, three_d

# --- App Layout ---
app.layout = html.Div(style={'backgroundColor': '#f1f2f6', 'fontFamily': 'sans-serif'}, children=[
    dcc.Store(id='right-click-store'),
    dcc.Download(id="download-csv"),
    
    # TOOLBAR
    html.Div(style={'padding': '15px', 'backgroundColor': '#1e272e', 'display': 'flex', 'gap': '10px', 'alignItems': 'center'}, children=[
        html.H2("Conveyor Layout Editor", style={'color': 'white', 'margin': '0 20px 0 0', 'fontSize': '20px'}),
        dcc.Upload(id='upload-data', children=html.Button('Upload CSV', style={'backgroundColor': '#2ecc71', 'color': 'white', 'border': 'none', 'padding': '10px', 'cursor': 'pointer'})),
        html.Button('+ Add Node', id='btn-add', n_clicks=0, style={'backgroundColor': '#3498db', 'color': 'white', 'border': 'none', 'padding': '10px', 'cursor': 'pointer'}),
        html.Button('Delete Selected', id='btn-delete', n_clicks=0, style={'backgroundColor': '#e74c3c', 'color': 'white', 'border': 'none', 'padding': '10px', 'cursor': 'pointer'}),
        html.Button('Export CSV', id='btn-save', n_clicks=0, style={'backgroundColor': '#95a5a6', 'color': 'white', 'border': 'none', 'padding': '10px', 'cursor': 'pointer'}),
        html.Div(id='status-msg', style={'color': '#ffa801', 'marginLeft': 'auto', 'fontSize': '14px'})
    ]),

    # VISUALS
    html.Div(style={'display': 'flex'}, children=[
        html.Div(style={'width': '40%', 'padding': '10px'}, children=[dcc.Graph(id='graph-side'), dcc.Graph(id='graph-top')]),
        html.Div(style={'width': '60%', 'padding': '10px'}, children=[dcc.Graph(id='graph-3d')])
    ]),

    # TABLE
    html.Div(style={'padding': '20px'}, children=[
        dash_table.DataTable(
            id='node-table',
            columns=[{'name': i.upper(), 'id': i} for i in ['id', 'group', 'x', 'y', 'z', 'tags']],
            data=initial_data,
            editable=True, row_selectable='single', selected_rows=[0],
            style_header={'backgroundColor': '#2f3640', 'color': 'white', 'fontWeight': 'bold'},
            style_cell={'textAlign': 'center', 'padding': '10px'}
        )
    ])
])

# --- Main Callback ---
@app.callback(
    Output('node-table', 'data'),
    Output('graph-side', 'figure'),
    Output('graph-top', 'figure'),
    Output('graph-3d', 'figure'),
    Output('status-msg', 'children'),
    Output('download-csv', 'data'),
    Input('btn-add', 'n_clicks'),
    Input('btn-delete', 'n_clicks'),
    Input('btn-save', 'n_clicks'),
    Input('upload-data', 'contents'),
    Input('node-table', 'data_timestamp'),
    State('upload-data', 'filename'),
    State('node-table', 'data'),
    State('node-table', 'selected_rows'),
    prevent_initial_call=False
)
def update_app(add_n, del_n, save_n, upload_content, ts, filename, table_data, selected_rows):
    ctx = dash.callback_context
    trigger = ctx.triggered[0]['prop_id'].split('.')[0] if ctx.triggered else None
    df = pd.DataFrame(table_data)
    download_data = dash.no_update

    # 1. Action: Upload CSV
    if trigger == 'upload-data' and upload_content:
        _, content_string = upload_content.split(',')
        decoded = base64.b64decode(content_string)
        df = pd.read_csv(io.StringIO(decoded.decode('utf-8')))
        if 'group' in df.columns:
            df = df.rename(columns={'group': 'group'})
        df['group'] = df['group'].map(lambda x: STRAND_MAP.get(x, x))
        status = f"Loaded: {filename}"

    # 2. Action: Add Node
    elif trigger == 'btn-add':
        new_id = int(df['id'].max() + 1) if not df.empty else 0
        lx = df.iloc[-1]['x'] if not df.empty else 0
        new_row = {'id': new_id, 'group': 'Blue', 'x': lx + 50, 'y': 0, 'z': 0, 'tags': ''}
        df = pd.concat([df, pd.DataFrame([new_row])], ignore_index=True)
        status = "Node Added"

    # 3. Action: Delete
    elif trigger == 'btn-delete' and selected_rows:
        df = df.drop(df.index[selected_rows[0]]).reset_index(drop=True)
        status = "Node Deleted"

    # 4. Action: Export CSV (Map back to 0/1)
    elif trigger == 'btn-save':
        export_df = df.copy().rename(columns={'group': 'group'})
        export_df['group'] = export_df['group'].map(lambda x: INV_STRAND_MAP.get(x, x))
        download_data = dcc.send_data_frame(export_df.to_csv, "conveyor_layout.csv", index=False)
        status = "File Exported"
    
    else:
        status = "Ready"

    side, top, three_d = get_figs(df)
    return df.to_dict('records'), side, top, three_d, status, download_data

if __name__ == '__main__':
    app.run(debug=True)