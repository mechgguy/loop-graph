import dash
from dash import dcc, html, Input, Output, State, callback_context
import plotly.graph_objects as go

app = dash.Dash(__name__)

# Initial Node Data
nodes = {
    'Node 0': {'x': 2, 'y': 5, 'color': 'blue'},
    'Node 1': {'x': 5, 'y': 8, 'color': 'red'},
}

def create_figure(node_data):
    fig = go.Figure()
    
    for name, data in node_data.items():
        fig.add_trace(go.Scatter(
            x=[data['x']], y=[data['y']],
            mode='markers+text',
            name=name,
            text=[name],
            textposition="top center",
            marker=dict(size=15, color=data['color']),
            customdata=[name]
        ))

    fig.update_layout(
        xaxis=dict(range=[0, 10], fixedrange=True),
        yaxis=dict(range=[0, 10], fixedrange=True),
        height=600,
        clickmode='event+select',
        dragmode='drawcircle', # Enables the drawing/moving tools
    )
    
    # This is the "Magic" config that allows moving things
    return fig

app.layout = html.Div(style={'display': 'flex'}, children=[
    html.Div(id='sidebar', style={'width': '250px', 'padding': '20px', 'background': '#eee'}, children=[
        html.H3("Coordinates"),
        html.Div(id='coord-list')
    ]),
    
    html.Div(style={'flex-grow': '1'}, children=[
        dcc.Graph(
            id='main-graph',
            figure=create_figure(nodes),
            config={'editable': True, 'edits': {'shapePosition': True}}
        )
    ])
])

@app.callback(
    Output('coord-list', 'children'),
    Input('main-graph', 'relayoutData'),
    prevent_initial_call=False
)
def display_coords(relayout_data):
    # This captures the movement when you move a point
    if relayout_data and 'margin' not in relayout_data:
        return html.Pre(f"New Position Data:\n{str(relayout_data)}")
    return "Click and drag a point to move it."

if __name__ == '__main__':
    app.run(debug=True, port=8050)