from flask import Flask, request, jsonify
from flask_cors import CORS
import ezdxf
import io
import pandas as pd

app = Flask(__name__)
CORS(app)

@app.route('/import-file', methods=['POST'])
def import_file():
    try:
        if 'file' not in request.files:
            return jsonify({"error": "No file uploaded"}), 400
            
        file = request.files['file']
        filename = file.filename.lower()

        # --- HANDLE EXCEL (.xlsx, .xls) ---
        if filename.endswith(('.xlsx', '.xls')):
            # Read first sheet
            # df = pd.read_excel(file)
            if filename.endswith('.xlsx'):
                df = pd.read_excel(file, engine='openpyxl')
            elif filename.endswith('.xls'):
                df = pd.read_excel(file, engine='xlrd')

            # Ensure column names are lowercase to avoid matching issues
            # df.columns = [str(col).lower() for col in df.columns]
            
            # Fill missing values to avoid JSON errors
            df = df.where(pd.notnull(df), None)
            
            # raw_data = df.to_dict(orient='records')
            nodes = []
            
            # for i, row in enumerate(raw_data):
            #     # Map Excel columns to our app's schema
            #     nodes.append({
            #         'id': row.get('id', i),
            #         'x': float(row.get('x', 0)),
            #         'y': float(row.get('y', 0)),
            #         'z': float(row.get('z', 0)),
            #         'group': int(row.get('group', 0)),
            #         'strand': row.get('strand', 'Carry'),
            #         'tags': str(row.get('tags', '')),
            #         'fromCsv': True
            #     })
            for i in range(len(df)):
                # Access by position: .iloc[row_index, col_index]
                # 0: id, 1: x, 2: y, 3: z, 4: group, 5: tags
                
                # Safely get the group value from the 5th column (index 4)
                # We use i, 4 because index 3 is typically 'z'
                try:
                    group_val = int(df.iloc[i, 4]) if df.shape[1] > 4 else 0
                except (ValueError, TypeError):
                    group_val = 0

                nodes.append({
                    'id': str(df.iloc[i, 0]) if df.shape[1] > 0 else i,
                    'x': float(df.iloc[i, 1]) if df.shape[1] > 1 else 0.0,
                    'y': float(df.iloc[i, 2]) if df.shape[1] > 2 else 0.0,
                    'z': float(df.iloc[i, 3]) if df.shape[1] > 3 else 0.0,
                    'group': group_val,
                    'strand': 'Return' if group_val == 1 else 'Carry',
                    'strandValue': 1 if group_val == 1 else -1,
                    'tags': str(df.iloc[i, 5]) if df.shape[1] > 5 else '',
                    'fromCsv': True
                })
            return jsonify(nodes)

        # --- HANDLE DXF (.dxf) ---
        elif filename.endswith('.dxf'):
            dxf_content = file.read().decode('utf-8', errors='ignore')
            doc = ezdxf.read(io.StringIO(dxf_content))
            msp = doc.modelspace()

            nodes = []
            for i, entity in enumerate(msp.query('POINT')):
                x, y, z = entity.dxf.location
                layer = entity.dxf.layer
                group_id = 1 if "1" in layer else 0
                
                nodes.append({
                    'id': f"cad_{i}",
                    'x': x,
                    'y': y,
                    'z': z,
                    'strand': 'Return' if group_id == 1 else 'Carry',
                    'strandValue': 1 if group_id == 1 else -1,
                    'group': group_id,
                    'tags': f'CAD Layer: {layer}',
                    'fromCsv': True
                })
            return jsonify(nodes)

        else:
            return jsonify({"error": "Unsupported file format"}), 400

    except Exception as e:
        print(f"Error: {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(port=5000, debug=True)