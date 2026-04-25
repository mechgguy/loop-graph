import dash
from dash import dcc, html, Input, Output, State, dash_table
import dash_cytoscape as cyto
import plotly.graph_objects as go
import pandas as pd
import numpy as np
import base64
import io

app = dash.Dash(__name__)

# --- Configuration ---
STRAND_MAP = {0: 'Blue', 1: 'Red'}
INV_STRAND_MAP = {'Blue': 0, 'Red': 1}
COLORS = {'Blue': '#3498db', 'Red': '#e74c3c'}

# --- Utilities ---
def calculate_metrics(df):
    """Calculates cumulative distance (Travel Distance) for the Profile View."""
    if df.empty: 
        return df
    
    # Ensure we are working with floats for math
    for col in ['x', 'y', 'z']:
        df[col] = pd.to_numeric(df[col], errors='coerce').astype(float).fillna(0.0)
    
    df = df.sort_values(['group', 'id'])
    df['cum_dist'] = 0.0
    
    for s in df['group'].unique():
        mask = df['group'] == s
        s_df = df[mask]
        if len(s_df) > 1:
            coords = s_df[['x', 'y']].values
            # Calculate Euclidean distance between consecutive points
            dists = np.sqrt(np.sum(np.diff(coords, axis=0)**2, axis=1))
            df.loc[mask, 'cum_dist'] = np.concatenate(([0], np.cumsum(dists)))
        else:
            df.loc[mask, 'cum_dist'] = 0.0
    return df


def df_to_cyto(df):
    """Converts DataFrame nodes and implicit edges to Cytoscape format."""
    elements = []
    # Nodes
    for _, row in df.iterrows():
        elements.append({
            'data': {'id': str(row['id']), 'label': f"ID {row['id']}", 'group': row['group']},
            'position': {'x': row['x'], 'y': row['y']}
        })
    # Edges (connecting nodes in sequence per group)
    for group in df['group'].unique():
        group_df = df[df['group'] == group].sort_values('id')
        nodes = group_df['id'].tolist()
        for i in range(len(nodes) - 1):
            elements.append({
                'data': {'source': str(nodes[i]), 'target': str(nodes[i+1]), 'group': group}
            })
    return elements

def get_3d_fig(df):
    fig = go.Figure()
    for s_name, color in COLORS.items():
        mask = df['group'] == s_name
        if mask.any():
            fig.add_trace(go.Scatter3d(
                x=df[mask]['x'], y=df[mask]['y'], z=df[mask]['z'],
                name=s_name, mode='lines+markers',
                line=dict(color=color, width=6),
                marker=dict(size=4)
            ))
    # fig.update_layout(template="plotly_dark", margin=dict(l=0, r=0, b=0, t=0), height=500)
    fig.update_layout(
        uirevision="constant_camera",
        template="plotly_dark",
        margin=dict(l=0, r=0, b=0, t=0),
        height=500,
        # This ensures the mouse can rotate the view
        scene=dict(
            xaxis=dict(visible=True),
            yaxis=dict(visible=True),
            zaxis=dict(visible=True),
            camera=dict(
                eye=dict(x=1.5, y=1.5, z=1.5) # Sets initial isometric perspective
            ),
            aspectmode='data' # Keeps the scale proportional
        ),
        dragmode='orbit' # Forces the default click-and-drag behavior to be rotation
    )
    return fig

# --- Layout ---
app.layout = html.Div(style={'backgroundColor': '#f1f2f6', 'fontFamily': 'sans-serif'}, children=[
    dcc.Download(id="download-csv"),
    dcc.Interval(id='auto-sync-interval', interval=10000, n_intervals=0),
    
    # TOOLBAR
    html.Div(style={'padding': '15px', 'backgroundColor': '#1e272e', 'display': 'flex', 'gap': '10px', 'alignItems': 'center'}, children=[
        html.H2("CONVEYOR CAD (DRAG ENABLED)", style={'color': 'white', 'margin': '0 20px 0 0', 'fontSize': '18px'}),
        dcc.Upload(id='upload-data', children=html.Button('Upload CSV', style={'backgroundColor': '#2ecc71', 'color': 'white', 'border': 'none', 'padding': '10px', 'cursor': 'pointer'})),
        html.Button('+ Add Node', id='btn-add', n_clicks=0, style={'backgroundColor': '#3498db', 'color': 'white', 'padding': '10px'}),
        html.Button('Delete Node', id='btn-delete', n_clicks=0, style={'backgroundColor': '#c0392b', 'color': 'white', 'padding': '10px'}),
        html.Button('Toggle Strand', id='btn-flip', n_clicks=0, style={'backgroundColor': '#f1c40f', 'padding': '10px', 'fontWeight': 'bold'}),
        html.Button('Export CSV', id='btn-save', n_clicks=0, style={'backgroundColor': '#95a5a6', 'color': 'white', 'padding': '10px'}),
        html.Button('UPDATE 3D VIEW', id='btn-sync', n_clicks=0, 
                style={'backgroundColor': '#8e44ad', 'color': 'white', 'padding': '10px', 'fontWeight': 'bold'}),
        html.Div(id='status-msg', style={'color': '#ffa801', 'marginLeft': 'auto', 'fontSize': '14px'})
    ]),

# Main Grid
    html.Div(style={'display': 'flex'}, children=[
        # Left Panel (Editors)
        html.Div(style={'width': '45%', 'padding': '10px'}, children=[
            html.H4("TOP VIEW (Floor Plan)"),
            cyto.Cytoscape(
                id='cyto-map', layout={'name': 'preset'},
                style={'width': '100%', 'height': '350px', 'backgroundColor': 'white', 'border': '1px solid #ccc'},
                elements=[],
                stylesheet=[
                    {'selector': 'node', 'style': {'label': 'data(id)', 'width': 20, 'height': 20}},
                    {'selector': '[group = "Blue"]', 'style': {'background-color': COLORS['Blue'], 'line-color': COLORS['Blue']}},
                    {'selector': '[group = "Red"]', 'style': {'background-color': COLORS['Red'], 'line-color': COLORS['Red']}},
                    {'selector': 'edge', 'style': {'width': 3}}
                ]
            ),
            html.Hr(),
            html.H4("PROFILE VIEW (Z-Elevation Control)"),
            dcc.Graph(id='graph-profile', config={'editable': True})
        ]),
        
        # Right Panel (3D)
        html.Div(style={'width': '55%', 'padding': '10px'}, children=[
            html.H4("3D PERSPECTIVE"),
            dcc.Graph(id='graph-3d') # <--- CRITICAL: This was likely missing or misspelled
        ])
    ]),

    # TABLE
    html.Div(style={'padding': '0 20px 20px 20px'}, children=[
        dash_table.DataTable(
            id='node-table',
            columns=[{'name': i.upper(), 'id': i} for i in ['id', 'group', 'x', 'y', 'z', 'tags']],
            data=[],
            editable=True, row_selectable='single', selected_rows=[0],
            style_header={'backgroundColor': '#2f3640', 'color': 'white'},
            style_cell={'textAlign': 'center', 'padding': '8px'}
        )
    ])
])

# --- Main Logic ---
@app.callback(
    Output('node-table', 'data'),
    Output('cyto-map', 'elements'),
    Output('graph-profile', 'figure'),
    Output('graph-3d', 'figure'),
    Output('status-msg', 'children'),
    Output('download-csv', 'data'),
    Input('btn-add', 'n_clicks'),
    Input('btn-delete', 'n_clicks'),
    Input('btn-flip', 'n_clicks'),
    Input('btn-save', 'n_clicks'),
    Input('auto-sync-interval', 'n_intervals'), # <--- Heartbeat
    Input('upload-data', 'contents'),
    Input('btn-sync', 'n_clicks'),           # <--- New Trigger
    # Input('cyto-map', 'elements'), # Triggered on Drag
    State('cyto-map', 'elements'),
    Input('node-table', 'data_timestamp'), # Triggered on Manual Table Edit
    State('node-table', 'data'),
    State('node-table', 'selected_rows'),
    prevent_initial_call=False
)
def master_callback(add_n, del_n, flip_n, save_n, sync_n, upload_content, restyle, cyto_elements, table_ts, table_data, selected_rows):
    ctx = dash.callback_context
    trigger = ctx.triggered[0]['prop_id'].split('.')[0] if ctx.triggered else None
    
    # Initialize or Update DataFrame
    if not table_data and not upload_content:
        # Start with initial dummy data if everything is empty
        df = pd.DataFrame([
            {'id': 0, 'x': 0, 'y': 0, 'z': 0, 'group': 'Blue', 'tags': 'start'},
            {'id': 1, 'x': 100, 'y': 50, 'z': 5, 'group': 'Blue', 'tags': ''},
            {'id': 2, 'x': 200, 'y': 0, 'z': 2, 'group': 'Red', 'tags': 'end'}
        ])
    else:
        df = pd.DataFrame(table_data)

        # # --- UPDATE THIS BLOCK ---
        # if not df.empty:
        #     # Force x, y, z to be floats (64-bit decimals)
        #     for col in ['x', 'y', 'z']:
        #         df[col] = pd.to_numeric(df[col], errors='coerce').astype(float).fillna(0.0)
        #     # Keep id as integer
        #     df['id'] = pd.to_numeric(df['id'], errors='coerce').fillna(0).astype(int)
        # # --------------------------

        # --- CRITICAL FIX: RE-CAST EVERY TIME ---
        if not df.empty:
            # We must cast to float BEFORE we try to assign any Cytoscape positions
            df['x'] = pd.to_numeric(df['x'], errors='coerce').astype(float)
            df['y'] = pd.to_numeric(df['y'], errors='coerce').astype(float)
            df['z'] = pd.to_numeric(df['z'], errors='coerce').astype(float)
            df['id'] = pd.to_numeric(df['id'], errors='coerce').fillna(0).astype(int)
        # ----------------------------------------


        # Ensure numbers
        for col in ['x', 'y', 'z', 'id']:
            df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)

    download_data = dash.no_update
    status = "System Ready"

    # --- 3. AUTO-SYNC LOGIC ---
    # We update x/y from Cytoscape positions on every heartbeat or when manually triggered
    if (trigger == 'auto-sync-interval' or trigger is None) and cyto_elements:
        for el in cyto_elements:
            if 'position' in el:
                nid = int(float(el['data']['id']))
                df.loc[df['id'] == nid, 'x'] = float(el['position']['x'])
                df.loc[df['id'] == nid, 'y'] = float(el['position']['y'])
        status = "Live Syncing..."

    # 1. ACTION: DRAG (Sync Cytoscape positions to DataFrame)
    if trigger == 'cyto-map':
        for el in cyto_elements:
            if 'position' in el: # It's a node
                node_id = int(el['data']['id'])
                df.loc[df['id'] == node_id, 'x'] = el['position']['x']
                df.loc[df['id'] == node_id, 'y'] = el['position']['y']
        status = "Node positions updated"

    # Action: Drag Elevation
    elif trigger == 'graph-profile' and restyle:
        new_z_vals = restyle[0].get('y')
        trace_idx = restyle[1][0]
        if new_z_vals:
            target_group = 'Blue' if trace_idx == 0 else 'Red'
            df.loc[df['group'] == target_group, 'z'] = new_z_vals[0]

    # 2. ACTION: ADD
    elif trigger == 'btn-add':
        new_id = int(df['id'].max() + 1) if not df.empty else 0
        new_row = {'id': new_id, 'group': 'Blue', 'x': 50, 'y': 50, 'z': 0, 'tags': ''}
        df = pd.concat([df, pd.DataFrame([new_row])], ignore_index=True)
        status = "Node added"

    # 3. ACTION: DELETE
    elif trigger == 'btn-delete' and selected_rows:
        df = df.drop(df.index[selected_rows[0]]).reset_index(drop=True)
        status = "Node deleted"

    # 4. ACTION: TOGGLE STRAND
    elif trigger == 'btn-flip' and selected_rows:
        idx = selected_rows[0]
        df.at[idx, 'group'] = 'Red' if df.at[idx, 'group'] == 'Blue' else 'Blue'
        status = "Strand toggled"

    # 5. ACTION: UPLOAD
    elif trigger == 'upload-data' and upload_content:
        try:
            # Check if upload_content is a string before splitting
            if isinstance(upload_content, str) and ',' in upload_content:
                _, content_string = upload_content.split(',')
                decoded = base64.b64decode(content_string)
                df = pd.read_csv(io.StringIO(decoded.decode('utf-8')))
                
                # Standardize columns
                if 'group' in df.columns: 
                    df = df.rename(columns={'group': 'group'})
                df['group'] = df['group'].map(lambda x: STRAND_MAP.get(x, x))
                status = "CSV Loaded"
            else:
                status = "Upload error: Invalid file format"
        except Exception as e:
            status = f"Upload failed: {str(e)}"
        

    # 6. ACTION: SAVE
    elif trigger == 'btn-save':
        export_df = df.copy().rename(columns={'group': 'group'})
        export_df['group'] = export_df['group'].map(lambda x: INV_STRAND_MAP.get(x, x))
        download_data = dcc.send_data_frame(export_df.to_csv, "conveyor_export.csv", index=False)
        status = "File Exported"

    # 1. ACTION: SYNC (Only happens when you click the purple button)
    if trigger == 'btn-sync' and cyto_elements:
        for el in cyto_elements:
            if 'position' in el:
                nid = int(float(el['data']['id']))
                df.loc[df['id'] == nid, 'x'] = float(el['position']['x'])
                df.loc[df['id'] == nid, 'y'] = float(el['position']['y'])
        status = "3D View Synchronized"

    # # Generate outputs
    # new_cyto_elements = df_to_cyto(df)
    # fig_3d = get_3d_fig(df)
    
    # return df.to_dict('records'), new_cyto_elements, fig_3d, status, download_data
    # Final rendering
    df = calculate_metrics(df)
    
    # Profile Fig
    profile_fig = go.Figure()
    for s_name, color in COLORS.items():
        mask = df['group'] == s_name
        if mask.any():
            profile_fig.add_trace(go.Scatter(x=df[mask]['cum_dist'], y=df[mask]['z'], name=s_name, mode='lines+markers', marker=dict(size=10, color=color)))
    profile_fig.update_layout(title="Elevation Profile (Drag Z)", height=300, margin=dict(t=30, b=30), dragmode='pan')

    # 3D Fig with camera protection
    three_d_fig = go.Figure()
    for s_name, color in COLORS.items():
        mask = df['group'] == s_name
        if mask.any():
            three_d_fig.add_trace(go.Scatter3d(x=df[mask]['x'], y=df[mask]['y'], z=df[mask]['z'], name=s_name, mode='lines+markers', line=dict(color=color, width=6)))
    three_d_fig.update_layout(template="plotly_dark", height=600, uirevision='camera_lock', scene=dict(aspectmode='data'), margin=dict(l=0, r=0, b=0, t=0))

    return df.to_dict('records'), df_to_cyto(df), profile_fig, three_d_fig, status, download_data

if __name__ == '__main__':
    app.run(debug=True)