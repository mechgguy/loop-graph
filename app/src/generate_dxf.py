import ezdxf

# Your updated example data (id, x, y, z, group)
csv_data = [
    (0, 0.0, 0.0, 0.0, 0),
    (1, 50.0, 0.0, 2.0, 0),
    (2, 150.0, 30.0, 8.0, 0),
    (3, 300.0, 80.0, 15.0, 0),
    (4, 450.0, 120.0, 25.0, 0),
    (5, 500.0, 130.0, 30.0, 0),
    (6, 500.0, 130.0, 28.0, 1), # Changed to group 1
    (7, 450.0, 120.0, 23.0, 1), # Changed to group 1
    (8, 300.0, 80.0, 13.0, 1), # Changed to group 1
    (9, 150.0, 30.0, 6.0, 1),  # Changed to group 1
    (10, 50.0, 0.0, 0.0, 1),   # Changed to group 1
    (11, 0.0, 0.0, -2.0, 1)    # Changed to group 1
]

def create_test_dxf(filename):
    doc = ezdxf.new('R2010')
    msp = doc.modelspace()

    # Create layers for the two groups to keep it organized
    doc.layers.add(name="Group_0", color=1) # Red
    doc.layers.add(name="Group_1", color=5) # Blue

    for node_id, x, y, z, group in csv_data:
        # Determine the layer name
        layer_name = f"Group_{group}"
        
        # Add the point using ONLY x, y, z for the location
        # The 'group' data is stored as the Layer attribute
        msp.add_point((x, y, z), dxfattribs={'layer': layer_name})

    doc.saveas(filename)
    print(f"Created {filename} with {len(csv_data)} points organized by Layer.")

if __name__ == "__main__":
    create_test_dxf("test_conveyor.dxf")