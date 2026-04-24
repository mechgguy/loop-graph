import dash
from dash import dcc, html, Input, Output, State, dash_table, no_update
import plotly.graph_objects as go
import pandas as pd
import numpy as np
import base64
import io

app = dash.Dash(__name__)

# --- Initial Data ---
initial_df = pd.DataFrame({
    'id': [0, 1, 2],
    'strand': ['Carry', 'Carry', 'Return'],
    'x': [0.0, 100.0, 200.0],
    'y': [0.0, 50.0, 0.0],
    'z': [0.0, 10.0, 5.0],
    'tags': ['tail', '', 'head']
})

# --- Helper Functions for Figures ---
def get_figs(df):
    # Side View Calculation (Cumulative distance)
    dists = [0]
    for i in range(1, len(df)):
        dists.append(dists[-1] + np.linalg.norm(df.iloc[i][['x','y']].values - df.iloc[i-1][['x','y']].values))
    
    # 2D Side View
    side = go.Figure()
    for s, c, d in [('Carry', '#3498db', 'solid'), ('Return', '#e74c3c', 'dash')]:
        mask = df['strand'] == s
        side.add_trace(go.Scatter(x=np.array(dists)[mask], y=df[mask]['z'], name=s, 
                                  mode='lines+markers', line=dict(color=c, dash=d)))
    side.update_layout(title="SIDE VIEW", margin=dict(t=30, b=30), height=250)

    # 2D Top View
    top = go.Figure()
    for s, c, d in [('Carry', '#3498db', 'solid'), ('Return', '#e74c3c', 'dash')]:
        mask = df['strand'] == s
        top.add_trace(go.Scatter(x=df[mask]['x'], y=df[mask]['y'], name=s, 
                                 mode='lines+markers', line=dict(color=c, dash=d)))
    top.update_layout(title="TOP VIEW", margin=dict(t=30, b=30), height=250)

    # 3D View
    three_d = go.Figure()
    for s, c, d in [('Carry', '#3498db', 'solid'), ('Return', '#e74c3c', 'dash')]:
        mask = df['strand'] == s
        three_d.add_trace(go.Scatter3d(x=df[mask]['x'], y=df[mask]['y'], z=df[mask]['z'], 
                                       name=s, mode='lines+markers',
                                       line=dict(color=c, width=5), marker=dict(size=4)))
    three_d.update_layout(title="3D VIEW", template="plotly_dark", margin=dict(t=30, b=0), height=500)
    
    return side, top, three_d

# --- Layout ---
app.layout = html.Div(style={'backgroundColor': '#f1f2f6', 'height': '100vh'}, children=[
    # Header & Toolbar
    html.Div(style={'padding': '15px', 'backgroundColor': '#1e272e', 'display': 'flex', 'gap': '10px'}, children=[
        html.Button('+ Add Node', id='btn-add', n_clicks=0, style={'backgroundColor': '#3498db', 'color': 'white', 'border': 'none', 'padding': '10px'}),
        html.Button('Flip Strand of Selected', id='btn-flip', n_clicks=0, style={'backgroundColor': '#f1c40f', 'color': 'black', 'border': 'none', 'padding': '10px'}),
        html.Div(id='status-msg', style={'color': 'white', 'marginLeft': 'auto', 'fontSize': '12px'})
    ]),

    # Main Visuals
    html.Div(style={'display': 'flex'}, children=[
        html.Div(style={'width': '40%'}, children=[
            dcc.Graph(id='graph-side'),
            dcc.Graph(id='graph-top')
        ]),
        html.Div(style={'width': '60%'}, children=[
            dcc.Graph(id='graph-3d')
        ])
    ]),

    # Table
    dash_table.DataTable(
        id='node-table',
        columns=[{'name': i.upper(), 'id': i} for i in initial_df.columns],
        data=initial_df.to_dict('records'),
        editable=True,
        row_selectable='single',
        selected_rows=[0],
        style_table={'height': '200px', 'overflowY': 'auto'},
        style_header={'backgroundColor': '#2f3640', 'color': 'white'},
        style_cell={'textAlign': 'center'}
    )
])

# --- Combined Callback ---
@app.callback(
    Output('node-table', 'data'),
    Output('graph-side', 'figure'),
    Output('graph-top', 'figure'),
    Output('graph-3d', 'figure'),
    Output('status-msg', 'children'),
    Input('btn-add', 'n_clicks'),
    Input('btn-flip', 'n_clicks'),
    Input('node-table', 'data_timestamp'),
    State('node-table', 'data'),
    State('node-table', 'selected_rows'),
    prevent_initial_call=False
)
def update_editor(add_clicks, flip_clicks, ts, table_data, selected_rows):
    ctx = dash.callback_context
    triggered_id = ctx.triggered[0]['prop_id'].split('.')[0] if ctx.triggered else None
    
    df = pd.DataFrame(table_data)

    # 1. Logic: Add Node
    if triggered_id == 'btn-add':
        new_id = int(df['id'].max() + 1)
        last_node = df.iloc[-1]
        new_row = {
            'id': new_id, 
            'strand': 'Carry', 
            'x': last_node['x'] + 50, 
            'y': last_node['y'], 
            'z': last_node['z'], 
            'tags': ''
        }
        df = pd.concat([df, pd.DataFrame([new_row])], ignore_index=True)

    # 2. Logic: Flip Strand (Toggle Blue/Red)
    elif triggered_id == 'btn-flip' and selected_rows:
        idx = selected_rows[0]
        current = df.at[idx, 'strand']
        df.at[idx, 'strand'] = 'Return' if current == 'Carry' else 'Carry'

    # Generate figures
    side_fig, top_fig, three_d_fig = get_figs(df)
    
    msg = f"Last action: {triggered_id}" if triggered_id else "Ready"
    return df.to_dict('records'), side_fig, top_fig, three_d_fig, msg

if __name__ == '__main__':
    app.run(debug=True)