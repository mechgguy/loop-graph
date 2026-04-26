from flask import Flask, request, jsonify
from flask_cors import CORS  # Important: Allows React to talk to Python
import ezdxf
import io

app = Flask(__name__)
CORS(app) # This prevents the "Cross-Origin" error

@app.route('/convert-dxf', methods=['POST'])
def convert_dxf():
    try:
        if 'file' not in request.files:
            return jsonify({"error": "No file uploaded"}), 400
            
        file = request.files['file']
        dxf_content = file.read().decode('utf-8', errors='ignore')
        
        # Correct way to read from a string stream
        doc = ezdxf.read(io.StringIO(dxf_content))
        msp = doc.modelspace()

        nodes = []
        # Extracting POINT entities
        for i, entity in enumerate(msp.query('POINT')):
            x, y, z = entity.dxf.location
            nodes.append({
                'id': i, # Front-end logic handles conversion to Number/String
                'x': x,
                'y': y,
                'z': z,
                'strand': 'Carry',
                'strandValue': -1,
                'group': 0,
                'tags': 'CAD Import',
                'fromCsv': True # Treat as source data for FIT logic
            })
        
        return jsonify(nodes)
    except Exception as e:
        print(f"Error: {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(port=5000)