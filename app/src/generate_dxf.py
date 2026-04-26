import ezdxf

# Your example data
csv_data = [
    (0, 0.0, 0.0, 0.0),
    (1, 50.0, 0.0, 2.0),
    (2, 150.0, 30.0, 8.0),
    (3, 300.0, 80.0, 15.0),
    (4, 450.0, 120.0, 25.0),
    (5, 500.0, 130.0, 30.0),
    (6, 500.0, 130.0, 28.0),
    (7, 450.0, 120.0, 23.0),
    (8, 300.0, 80.0, 13.0),
    (9, 150.0, 30.0, 6.0),
    (10, 50.0, 0.0, 0.0),
    (11, 0.0, 0.0, -2.0)
]

def create_test_dxf(filename):
    doc = ezdxf.new('R2010')
    msp = doc.modelspace()

    for node_id, x, y, z in csv_data:
        # Create a POINT entity in the CAD file
        msp.add_point((x, y, z))

    doc.saveas(filename)
    print(f"Created {filename} with {len(csv_data)} points.")

if __name__ == "__main__":
    create_test_dxf("test_conveyor.dxf")