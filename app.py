import os
import sys
import csv
import glob
from flask import Flask, render_template, jsonify, request, make_response

if getattr(sys, 'frozen', False):
    template_folder = os.path.join(sys._MEIPASS, 'templates')
    static_folder = os.path.join(sys._MEIPASS, 'static')
    app = Flask(__name__, template_folder=template_folder, static_folder=static_folder)
else:
    app = Flask(__name__)

# ブラウザキャッシュを完全に無効化する
@app.after_request
def add_header(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '-1'
    return response

# EXE化を考慮したベースディレクトリ取得
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DATA_DIR = os.path.join(BASE_DIR, 'data')
PROJECTS_DIR = os.path.join(DATA_DIR, 'projects')

def get_project_dir(project_name):
    if not project_name:
        project_name = 'Sample'
    p_dir = os.path.join(PROJECTS_DIR, project_name)
    if not os.path.exists(p_dir):
        os.makedirs(p_dir, exist_ok=True)
    return p_dir

def read_csv_as_dicts(filepath):
    if not os.path.exists(filepath):
        return []
    with open(filepath, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        return list(reader)

def write_dicts_to_csv(filepath, fieldnames, data):
    with open(filepath, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(data)

import time

@app.after_request
def add_header(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '-1'
    return response

@app.route('/')
def index():
    return render_template('index.html', ts=int(time.time()))

@app.route('/master_editor')
def master_editor():
    return render_template('master_editor.html', ts=int(time.time()))

@app.route('/api/log', methods=['POST'])
def receive_log():
    data = request.get_json()
    if data:
        print(f"\\n============================\\n[JS {data.get('type', 'INFO')}] {data.get('message', '')}\\n============================\\n")
    return jsonify({"status": "ok"})

@app.route('/api/restart', methods=['POST'])
def restart_server():
    print("Restart requested. Exiting current process...")
    if os.path.exists('WBSツール起動.bat'):
        os.system('start "" "WBSツール起動.bat"')
    os._exit(0)
    return jsonify({"status": "ok"})

@app.route('/api/projects', methods=['GET'])
def get_projects():
    if not os.path.exists(PROJECTS_DIR):
        os.makedirs(os.path.join(PROJECTS_DIR, 'Sample'), exist_ok=True)
    projects = [d for d in os.listdir(PROJECTS_DIR) if os.path.isdir(os.path.join(PROJECTS_DIR, d))]
    if not projects:
        projects = ['Sample']
    return jsonify(projects)

@app.route('/api/masters', methods=['GET'])
def get_masters():
    project_name = request.args.get('project', 'Sample')
    p_dir = get_project_dir(project_name)
    masters = {
        'release': read_csv_as_dicts(os.path.join(p_dir, 'm_release.csv')),
        'character': read_csv_as_dicts(os.path.join(p_dir, 'm_character.csv')),
        'section': read_csv_as_dicts(os.path.join(p_dir, 'm_section.csv')),
        'member': read_csv_as_dicts(os.path.join(p_dir, 'm_member.csv')),
        'task_template': read_csv_as_dicts(os.path.join(p_dir, 'm_task_template.csv')),
        'holiday': read_csv_as_dicts(os.path.join(p_dir, 'm_holiday.csv'))
    }
    return jsonify(masters)

@app.route('/api/tasks', methods=['GET'])
def get_tasks():
    project_name = request.args.get('project', 'Sample')
    p_dir = get_project_dir(project_name)
    print(f"DEBUG: p_dir={p_dir}")
    tasks = []
    # EXE化環境でのglobバグを回避するため、os.listdirで手動抽出
    try:
        files = os.listdir(p_dir)
        task_files = [os.path.join(p_dir, f) for f in files if f.startswith('t_tasks_') and f.endswith('.csv')]
    except Exception as e:
        print(f"DEBUG: Error reading directory: {e}")
        task_files = []
        
    print(f"DEBUG: task_files={task_files}")
    for f in task_files:
        tasks.extend(read_csv_as_dicts(f))
    return jsonify(tasks)

@app.route('/api/tasks/save', methods=['POST'])
def save_tasks():
    try:
        project_name = request.args.get('project', 'Sample')
        p_dir = get_project_dir(project_name)
        data = request.json
        # セクションごとにデータを分けて保存
        tasks_by_section = {}
        for task in data:
            sec_id = task.get('section_id')
            if sec_id not in tasks_by_section:
                tasks_by_section[sec_id] = []
            tasks_by_section[sec_id].append(task)
        
        # 既存のタスクCSVをクリアするか上書きする処理
        # ここでは受け取ったデータをS_xxx別に分けて t_tasks_xxx.csv に上書きする
        # （簡易的に section_id をそのままファイル名に利用）
        fieldnames = ['task_id', 'release_id', 'char_id', 'section_id', 'task_name', 'member_id', 'start_date', 'end_date', 'progress', 'lane']
        for sec_id, tasks in tasks_by_section.items():
            filepath = os.path.join(p_dir, f't_tasks_{sec_id}.csv')
            write_dicts_to_csv(filepath, fieldnames, tasks)
            
        return jsonify({'status': 'success'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/masters/save', methods=['POST'])
def save_masters():
    try:
        project_name = request.args.get('project', 'Sample')
        p_dir = get_project_dir(project_name)
        data = request.json
        # data = { 'release': [...], 'character': [...], ... }
        master_files = {
            'release': ('m_release.csv', ['release_id', 'release_name', 'art_deadline', 'branch_deadline', 'release_date', 'event_name']),
            'character': ('m_character.csv', ['char_id', 'char_name', 'costume_name', 'category', 'usage', 'event_id']),
            'section': ('m_section.csv', ['section_id', 'section_name', 'color']),
            'member': ('m_member.csv', ['member_id', 'member_name', 'section_id', 'color']),
            'task_template': ('m_task_template.csv', ['template_id', 'section_id', 'task_name', 'default_days']),
            'holiday': ('m_holiday.csv', ['holiday_date', 'holiday_name', 'holiday_type'])
        }
        for key, records in data.items():
            if key in master_files:
                filename, fieldnames = master_files[key]
                filepath = os.path.join(p_dir, filename)
                write_dicts_to_csv(filepath, fieldnames, records)
        return jsonify({'status': 'success'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

if __name__ == '__main__':
    import threading
    import webbrowser
    import time
    import subprocess
    import sys

    # 新しいポート番号（以前のゾンビプロセスを完全に回避するため5004に変更）
    PORT = 5004

    def open_browser():
        time.sleep(1.5)
        url = f'http://127.0.0.1:{PORT}/'
        try:
            # Chromeを強制的に開く試み
            chrome_path_64 = 'C:/Program Files/Google/Chrome/Application/chrome.exe %s'
            chrome_path_32 = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe %s'
            
            if os.path.exists('C:/Program Files/Google/Chrome/Application/chrome.exe'):
                webbrowser.get(chrome_path_64).open(url)
            elif os.path.exists('C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'):
                webbrowser.get(chrome_path_32).open(url)
            else:
                webbrowser.open(url)
        except Exception:
            webbrowser.open(url)
        
    if not os.environ.get('WERKZEUG_RUN_MAIN'):
        threading.Thread(target=open_browser, daemon=True).start()

    if getattr(sys, 'frozen', False):
        app.run(debug=False, port=PORT)
    else:
        app.run(debug=True, port=PORT)

