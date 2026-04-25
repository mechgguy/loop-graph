import pandas as pd
import plotly.express as px

def visualize_points(csv_file):
    # 1. Load the data
    df = pd.read_csv(csv_file)
    
    # Ensure a 'group' column exists for coloring, or create a dummy one
    if 'group' not in df.columns:
        df['group'] = 'Group A'
        
    # 2. Add a 'Point ID' column for numbering
    # This will be used for the text labels
    df['point_id'] = range(len(df))

    # 3. Create the 3D Scatter Plot
    fig = px.scatter_3d(
        df, 
        x='x', y='y', z='z',
        color='group',      # Color points by their group
        text='point_id',    # Show the number on each point
        title="3D Point Visualization",
        labels={'point_id': 'Point #'}
    )

    # 4. Refine the visual style
    fig.update_traces(
        marker=dict(size=5), # Adjust point size
        textposition='top center' # Position of the numbers
    )

    # 5. Show in browser
    fig.show()

if __name__ == "__main__":
    # Change 'points.csv' to your actual file path
    visualize_points('data/path_simple.csv')