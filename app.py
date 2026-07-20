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

import logging
log = logging.getLogger('werkzeug')
class HeartbeatFilter(logging.Filter):
    def filter(self, record):
        return "/api/heartbeat" not in record.getMessage()
log.addFilter(HeartbeatFilter())

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
COMMON_DIR = os.path.join(DATA_DIR, 'common')

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
    with open(filepath, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        return list(reader)

def write_dicts_to_csv(filepath, fieldnames, data):
    with open(filepath, 'w', encoding='utf-8-sig', newline='') as f:
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
    prompt_path = os.path.join(COMMON_DIR, 'prompt_system.txt')
    default_prompt = ""
    if os.path.exists(prompt_path):
        with open(prompt_path, 'r', encoding='utf-8') as f:
            default_prompt = f.read()
    else:
        default_prompt = """あなたは優秀なプロジェクト管理アシスタントです。
アジャイル開発やウォーターフォール開発の手法に精通しており、PMBOKの知識（スコープ管理、スケジュール管理、リソース管理、リスク管理など）を深く理解しています。プロジェクトマネジメントのプロフェッショナルとして、論理的かつ実践的な視点からアドバイスを行います。

ユーザーからスケジュールの調整・変更・提案を求められた場合は、プロジェクトマネジメントのベストプラクティスに基づいた日本語の解説文とともに、変更後のスケジュールデータを以下のJSON形式のコードブロック（ ```json ... ``` ）で「必ず」出力してください。

[出力形式]
```json
[
  {
    "id": "タスクID（例: TSK_00001）",
    "start": "新しい開始日（YYYY-MM-DD）",
    "end": "新しい終了日（YYYY-MM-DD）"
  }
]
```"""
        # ファイルが存在しない場合は作成しておく
        os.makedirs(COMMON_DIR, exist_ok=True)
        with open(prompt_path, 'w', encoding='utf-8') as f:
            f.write(default_prompt)

    return render_template('index.html', ts=int(time.time()), default_system_prompt=default_prompt)

@app.route('/master_editor')
def master_editor():
    return render_template('master_editor.html', ts=int(time.time()))

@app.route('/api/log', methods=['POST'])
def receive_log():
    data = request.get_json()
    if data:
        print(f"\n============================\n[JS {data.get('type', 'INFO')}] {data.get('message', '')}\n============================\n")
    return jsonify({"status": "ok"})

# ハートビート時刻をファイルで共有・保持する（マルチプロセス/Debugモード対応）
HEARTBEAT_FILE = os.path.join(DATA_DIR, 'heartbeat.txt')

@app.route('/api/heartbeat', methods=['POST'])
def heartbeat():
    try:
        # dataディレクトリがない場合は作成
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(HEARTBEAT_FILE, 'w', encoding='utf-8') as f:
            f.write(str(time.time()))
    except Exception as e:
        print("Heartbeat write error:", e)
    return jsonify({"status": "ok"})

@app.route('/api/restart', methods=['POST'])
def restart_server():
    print("Restart requested. Exiting current process...")
    if os.path.exists('WBSツール起動.bat'):
        # startコマンドで新しいウィンドウを開く
        os.system('start "" "WBSツール起動.bat"')
    # 自プロセスを終了（コマンドプロンプトも連動して閉じる）
    os._exit(0)
    return jsonify({"status": "ok"})

@app.route('/api/shutdown', methods=['POST'])
def shutdown_server_api():
    print("\n========================================================")
    print("Browser closed. Shutting down Flask server and CMD...")
    print("========================================================\n")
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
        'status': read_csv_as_dicts(os.path.join(p_dir, 'm_status.csv')),
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
        
        # 既存 of タスクCSVをクリアするか上書きする処理
        # ここでは受け取ったデータをS_xxx別に分けて t_tasks_xxx.csv に上書きする
        # （簡易的に section_id をそのままファイル名に利用）
        fieldnames = ['task_id', 'release_id', 'char_id', 'section_id', 'task_name', 'member_id', 'start_date', 'end_date', 'progress', 'lane', 'dependencies', 'status_id']
        for sec_id, tasks in tasks_by_section.items():
            filepath = os.path.join(p_dir, f't_tasks_{sec_id}.csv')
            write_dicts_to_csv(filepath, fieldnames, tasks)
            
        return jsonify({'status': 'success'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/deadlines', methods=['GET'])
def get_deadlines():
    project_name = request.args.get('project', 'Sample')
    p_dir = get_project_dir(project_name)
    filepath = os.path.join(p_dir, 't_section_deadlines.csv')
    deadlines = read_csv_as_dicts(filepath)
    return jsonify(deadlines)

@app.route('/api/deadlines/save', methods=['POST'])
def save_deadlines():
    try:
        project_name = request.args.get('project', 'Sample')
        p_dir = get_project_dir(project_name)
        data = request.json
        filepath = os.path.join(p_dir, 't_section_deadlines.csv')
        fieldnames = ['release_id', 'char_id', 'section_id', 'deadline_date']
        write_dicts_to_csv(filepath, fieldnames, data)
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
            'member': ('m_member.csv', ['member_id', 'member_name', 'display_name', 'section_id', 'bg_color', 'text_color']),
            'status': ('m_status.csv', ['status_id', 'status_name', 'color']),
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

# ==========================================
# AI Assistant API Proxy
# ==========================================
import urllib.request
import json
import urllib.error

@app.route('/api/llm/models', methods=['POST'])
def get_llm_models():
    data = request.json
    provider = data.get('provider')
    api_key = data.get('apiKey')
    if not api_key:
        return jsonify({"status": "error", "message": "APIキーが設定されていません。"}), 400

    models = []
    try:
        if provider == 'openai':
            req = urllib.request.Request("https://api.openai.com/v1/models")
            req.add_header("Authorization", f"Bearer {api_key}")
            with urllib.request.urlopen(req) as response:
                res_data = json.loads(response.read().decode('utf-8'))
                models = [m['id'] for m in res_data.get('data', []) if m['id'].startswith('gpt-')]
        elif provider == 'gemini':
            url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req) as response:
                res_data = json.loads(response.read().decode('utf-8'))
                models = [m['name'].replace('models/', '') for m in res_data.get('models', []) if 'generateContent' in m.get('supportedGenerationMethods', [])]
        elif provider == 'claude':
            req = urllib.request.Request("https://api.anthropic.com/v1/models")
            req.add_header("x-api-key", api_key)
            req.add_header("anthropic-version", "2023-06-01")
            with urllib.request.urlopen(req) as response:
                res_data = json.loads(response.read().decode('utf-8'))
                models = [m['id'] for m in res_data.get('data', []) if m.get('type') == 'model']
        else:
            return jsonify({"status": "error", "message": "このプロバイダは動的取得に対応していません。"}), 400
            
    except urllib.error.HTTPError as e:
        error_msg = e.read().decode('utf-8')
        return jsonify({"status": "error", "message": f"APIエラー ({e.code}): {error_msg}"}), 400
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

    models.sort(reverse=True) # 新しいモデルが上に来るように簡易ソート

    # 動的取得したモデル一覧と既存のCSV価格マスタを比較し、未知のモデルがあれば単価 0.0 として自動追記
    try:
        import csv
        import os
        csv_path = os.path.join("data", "common", "m_llm_pricing.csv")
        os.makedirs(os.path.dirname(csv_path), exist_ok=True)
        existing_models = set()
        rows = []
        fieldnames = ["model_name", "input_cost_1m", "output_cost_1m", "provider"]
        if os.path.exists(csv_path):
            with open(csv_path, "r", newline="", encoding="utf-8-sig") as f:
                reader = csv.DictReader(f)
                if reader.fieldnames:
                    fieldnames = reader.fieldnames
                for row in reader:
                    existing_models.add(row.get("model_name", "").strip())
                    rows.append(row)
        
        added_new = False
        provider_name_map = {'openai': 'OpenAI', 'claude': 'Anthropic', 'gemini': 'Google'}
        provider_name = provider_name_map.get(provider, 'Unknown')
        
        for m in models:
            if m not in existing_models:
                rows.append({
                    "model_name": m,
                    "input_cost_1m": "0.0",
                    "output_cost_1m": "0.0",
                    "provider": provider_name
                })
                added_new = True
                
        if added_new:
            with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(rows)
    except Exception as e:
        print(f"価格マスタの自動更新に失敗しました: {e}")

    return jsonify({"status": "success", "models": models})

DEFAULT_PRICING = [
    # model_name, input_cost_1m, output_cost_1m, provider
    ("USD_JPY", 155.00, 155.00, "SYSTEM"),
    # ※モデルの追加・編集は data/common/m_llm_pricing.csv を直接編集してください
]

PRICING_CSV_PATH = os.path.join("data", "common", "m_llm_pricing.csv")

@app.route('/api/llm/pricing', methods=['GET'])
def get_llm_pricing():
    import csv
    os.makedirs(os.path.dirname(PRICING_CSV_PATH), exist_ok=True)
    
    if not os.path.exists(PRICING_CSV_PATH):
        try:
            with open(PRICING_CSV_PATH, "w", newline="", encoding="utf-8-sig") as f:
                writer = csv.writer(f)
                writer.writerow(["model_name", "input_cost_1m", "output_cost_1m", "provider"])
                for row in DEFAULT_PRICING:
                    writer.writerow(row)
        except Exception as e:
            return jsonify({"status": "error", "message": f"デフォルト価格表の作成に失敗しました: {str(e)}"}), 500

    pricing_list = []
    try:
        with open(PRICING_CSV_PATH, "r", newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                try:
                    pricing_list.append({
                        "model_name": row["model_name"].strip(),
                        "input_cost_1m": float(row["input_cost_1m"]),
                        "output_cost_1m": float(row["output_cost_1m"]),
                        "provider": row["provider"].strip()
                    })
                except (ValueError, KeyError):
                    continue
    except Exception as e:
        return jsonify({"status": "error", "message": f"価格表の読み込みに失敗しました: {str(e)}"}), 500

    return jsonify({"status": "success", "pricing": pricing_list})

@app.route('/api/llm/chat', methods=['POST'])
def ai_chat_proxy():
    data = request.json
    provider = data.get('provider')
    api_key = data.get('apiKey')
    model = data.get('model')
    messages = data.get('messages', [])
    system_prompt = data.get('systemPrompt', '')
    temperature = data.get('temperature', 0.7)
    images = data.get('images', []) # list of base64 strings like 'data:image/png;base64,...'

    if not api_key or not model:
        return jsonify({"status": "error", "message": "APIキーとモデルが正しく設定されていません。"}), 400

    try:
        reply_text = ""
        total_tokens = 0
        input_tokens = 0
        output_tokens = 0

        if provider == 'openai':
            reply_text, input_tokens, output_tokens, total_tokens = _handle_openai_chat(
                model, messages, system_prompt, temperature, images, api_key)
        elif provider == 'claude':
            reply_text, input_tokens, output_tokens, total_tokens = _handle_claude_chat(
                model, messages, system_prompt, temperature, images, api_key)
        elif provider == 'gemini':
            reply_text, input_tokens, output_tokens, total_tokens = _handle_gemini_chat(
                model, messages, system_prompt, temperature, images, api_key)
        else:
            return jsonify({"status": "error", "message": f"不明なプロバイダです: {provider}"}), 400
        return jsonify({
            "status": "success",
            "reply": reply_text,
            "tokens": total_tokens,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens
        })
        
    except urllib.error.HTTPError as e:
        error_msg = e.read().decode('utf-8')
        return jsonify({"status": "error", "message": f"APIエラー ({e.code}): {error_msg}"}), 400
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500



# --- LLM Provider Handlers ---

def _get_last_user_msg_idx(msgs):
    for i in range(len(msgs)-1, -1, -1):
        if msgs[i]['role'] == 'user':
            return i
    return -1

def _handle_openai_chat(model, messages, system_prompt, temperature, images, api_key):
    import urllib.request, json
    api_url = "https://api.openai.com/v1/chat/completions"
    payload_messages = []
    if system_prompt:
        payload_messages.append({"role": "system", "content": system_prompt})
    
    cloned_messages = [dict(m) for m in messages]
    if images:
        last_idx = _get_last_user_msg_idx(cloned_messages)
        if last_idx != -1:
            original_content = cloned_messages[last_idx]['content']
            new_content = [{"type": "text", "text": original_content}]
            for img in images:
                new_content.append({"type": "image_url", "image_url": {"url": img}})
            cloned_messages[last_idx]['content'] = new_content
            
    payload_messages.extend(cloned_messages)
    payload = {
        "model": model,
        "messages": payload_messages,
        "temperature": temperature
    }
    
    req = urllib.request.Request(api_url, data=json.dumps(payload).encode('utf-8'))
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")
    
    with urllib.request.urlopen(req) as response:
        res_data = json.loads(response.read().decode('utf-8'))
        reply_text = res_data['choices'][0]['message']['content']
        total_tokens = res_data.get('usage', {}).get('total_tokens', 0)
        input_tokens = res_data.get('usage', {}).get('prompt_tokens', 0)
        output_tokens = res_data.get('usage', {}).get('completion_tokens', 0)
    return reply_text, input_tokens, output_tokens, total_tokens

def _handle_claude_chat(model, messages, system_prompt, temperature, images, api_key):
    import urllib.request, json
    api_url = "https://api.anthropic.com/v1/messages"
    cloned_messages = [dict(m) for m in messages]
    
    if images:
        last_idx = _get_last_user_msg_idx(cloned_messages)
        if last_idx != -1:
            original_content = cloned_messages[last_idx]['content']
            new_content = [{"type": "text", "text": original_content}]
            for img in images:
                if ',' in img:
                    header, b64data = img.split(',', 1)
                    media_type = header.split(':')[1].split(';')[0]
                    new_content.append({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": b64data
                        }
                    })
            cloned_messages[last_idx]['content'] = new_content
            
    payload = {
        "model": model,
        "max_tokens": 4096,
        "temperature": temperature,
        "messages": cloned_messages
    }
    if system_prompt:
        payload["system"] = system_prompt
        
    req = urllib.request.Request(api_url, data=json.dumps(payload).encode('utf-8'))
    req.add_header("x-api-key", api_key)
    req.add_header("anthropic-version", "2023-06-01")
    req.add_header("Content-Type", "application/json")
    
    with urllib.request.urlopen(req) as response:
        res_data = json.loads(response.read().decode('utf-8'))
        reply_text = res_data['content'][0]['text']
        input_tokens = res_data.get('usage', {}).get('input_tokens', 0)
        output_tokens = res_data.get('usage', {}).get('output_tokens', 0)
        total_tokens = input_tokens + output_tokens
    return reply_text, input_tokens, output_tokens, total_tokens

def _handle_gemini_chat(model, messages, system_prompt, temperature, images, api_key):
    import urllib.request, json
    api_url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    gemini_messages = []
    
    last_user_idx = _get_last_user_msg_idx(messages)
    
    for idx, msg in enumerate(messages):
        parts = [{"text": msg['content']}]
        
        if idx == last_user_idx and images:
            for img in images:
                if ',' in img:
                    header, b64data = img.split(',', 1)
                    mime_type = header.split(':')[1].split(';')[0]
                    parts.append({
                        "inline_data": {
                            "mime_type": mime_type,
                            "data": b64data
                        }
                    })

        gemini_messages.append({
            "role": "user" if msg['role'] == "user" else "model",
            "parts": parts
        })
        
    payload = {
        "contents": gemini_messages,
        "generationConfig": {
            "temperature": temperature
        }
    }
    if system_prompt:
        payload["systemInstruction"] = {
            "parts": [{"text": system_prompt}]
        }

    req = urllib.request.Request(api_url, data=json.dumps(payload).encode('utf-8'))
    req.add_header("Content-Type", "application/json")
    
    with urllib.request.urlopen(req) as response:
        res_data = json.loads(response.read().decode('utf-8'))
        reply_text = res_data['candidates'][0]['content']['parts'][0]['text']
        input_tokens = res_data.get('usageMetadata', {}).get('promptTokenCount', 0)
        output_tokens = res_data.get('usageMetadata', {}).get('candidatesTokenCount', 0)
        total_tokens = res_data.get('usageMetadata', {}).get('totalTokenCount', 0)
    return reply_text, input_tokens, output_tokens, total_tokens


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
        
    def check_heartbeat():
        # 初回起動時にハートビートファイルを作成・初期化
        os.makedirs(DATA_DIR, exist_ok=True)
        h_file = os.path.join(DATA_DIR, 'heartbeat.txt')
        with open(h_file, 'w', encoding='utf-8') as f:
            f.write(str(time.time()))

        time.sleep(15)  # 初回起動時の猶予
        while True:
            time.sleep(3)
            try:
                if os.path.exists(h_file):
                    with open(h_file, 'r', encoding='utf-8') as f:
                        val = float(f.read().strip())
                    # 5秒以上ハートビートファイルが更新されていなければ終了
                    if time.time() - val > 5:
                        print("Browser closed. Exiting server...")
                        # CMDウィンドウごと強制終了する
                        if os.name == 'nt':
                            # 親プロセスのCMDを終了させる
                            os.system('taskkill /F /IM cmd.exe /T >nul 2>&1')
                        os._exit(0)
                else:
                    # ファイルが消された場合も終了
                    print("Heartbeat file missing. Exiting server...")
                    if os.name == 'nt':
                        os.system('taskkill /F /IM cmd.exe /T >nul 2>&1')
                    os._exit(0)
            except Exception as e:
                # 読み込み中の一時的な競合等はスキップ
                pass

    if not os.environ.get('WERKZEUG_RUN_MAIN'):
        threading.Thread(target=open_browser, daemon=True).start()
        threading.Thread(target=check_heartbeat, daemon=True).start()

    if getattr(sys, 'frozen', False):
        app.run(debug=False, port=PORT)
    else:
        app.run(debug=True, port=PORT)
