import os
import csv
from datetime import datetime, timedelta
import random

BASE_DIR = 'data/projects/Sample'
CSV_DIR = os.path.join(BASE_DIR, 'CSV')

os.makedirs(CSV_DIR, exist_ok=True)

# 1. マスターデータの定義
sections = [
    {"section_id": "S_001", "section_name": "2D", "color": "#FF6B6B"},
    {"section_id": "S_003", "section_name": "3D_Char", "color": "#FFD43B"},
    {"section_id": "S_002", "section_name": "Motion", "color": "#4DABF7"},
    {"section_id": "S_004", "section_name": "Effect", "color": "#BA55D3"},
    {"section_id": "S_005", "section_name": "BG", "color": "#20B2AA"}
]

statuses = [
    {"status_id": "ST_001", "status_name": "未着手", "color": "#9CA3AF"}, # 灰色
    {"status_id": "ST_002", "status_name": "対応中", "color": "#3B82F6"}, # 青
    {"status_id": "ST_003", "status_name": "修正中", "color": "#F59E0B"}, # オレンジ
    {"status_id": "ST_004", "status_name": "保留",   "color": "#EF4444"}, # 赤
    {"status_id": "ST_005", "status_name": "完了",   "color": "#10B981"}  # 緑
]

members = []
member_id_count = 1
color_combinations = [
    ("#1E90FF", "#FFFFFF"), ("#32CD32", "#FFFFFF"), ("#FF8C00", "#FFFFFF"),
    ("#FF1493", "#FFFFFF"), ("#8A2BE2", "#FFFFFF"), ("#00CED1", "#FFFFFF"),
    ("#FFD700", "#000000"), ("#FFC0CB", "#000000"), ("#98FB98", "#000000"),
    ("#E6E6FA", "#000000")
]

for s in sections:
    for i in range(2): 
        colors = random.choice(color_combinations)
        
        # 3文字ルール display_name 構築
        sec_name = s['section_name']
        if sec_name == "3D_Char":
            disp_name = f"3D{i+1}"
        elif sec_name == "Motion":
            disp_name = f"Mo{i+1}"
        elif sec_name == "Effect":
            disp_name = f"Ef{i+1}"
        elif sec_name == "2D":
            disp_name = f"2D{i+1}"
        else:
            disp_name = f"BG{i+1}"

        members.append({
            "member_id": f"M_{member_id_count:03d}",
            "member_name": f"担当_{s['section_name']}_{i+1}",
            "display_name": disp_name,
            "section_id": s['section_id'],
            "bg_color": colors[0],
            "text_color": colors[1]
        })
        member_id_count += 1

tasks_by_section = {
    "S_001": [("キャラデザイン", 10), ("背景デザイン", 5), ("武器デザイン", 4)],
    "S_003": [("キャラモデル作成", 14), ("武器モデル作成", 6), ("セットアップ", 3)],
    "S_002": [("戦闘_待機", 2), ("戦闘_攻撃1", 3), ("戦闘_攻撃2", 3), ("戦闘_必殺技", 5), ("戦闘_ダウン", 1), ("戦闘_被弾", 1), ("ADV", 4)],
    "S_004": [("戦闘_待機", 2), ("戦闘_攻撃1", 3), ("戦闘_攻撃2", 3), ("戦闘_必殺技", 5), ("戦闘_ダウン", 1), ("戦闘_被弾", 1), ("ADV", 2)],
    "S_005": [("背景モデル", 15)]
}

# 順序定義
section_flow = ["S_001", "S_003", "S_002", "S_004"] # 2D -> キャラ -> モーション -> エフェクト

releases = []
characters = []
start_date_base = datetime(2026, 8, 1)

char_id_count = 1
tasks_out = {s['section_id']: [] for s in sections}
deadlines_out = []
task_id_count = 1

for i in range(24):
    r_start = start_date_base + timedelta(days=30*i)
    # バージョン名を v1.1.0 形式などに変更
    major = 1 + (i // 12)
    minor = (i % 12) + 1
    ver = f"v{major}.{minor}.0"
    
    r_id = f"R_{i+1:03d}"
    
    # 2体キャラ
    chars_in_release = []
    for j in range(2):
        c_id = f"C_{char_id_count:03d}"
        char_data = {
            "char_id": c_id,
            "char_name": f"キャラ_{char_id_count:03d}",
            "costume_name": f"衣装_{random.choice(['A','B','C'])}",
            "category": "恒常",
            "usage": "Playable",
            "event_id": f"Event_{i+1:03d}"
        }
        characters.append(char_data)
        chars_in_release.append(char_data)
        char_id_count += 1
        
    release_max_date = r_start

    # 各キャラごとのタスクとデッドライン生成
    for c in chars_in_release:
        current_date = r_start
        prev_task_id = None
        
        # フロー順にセクションを処理
        for s_id in section_flow:
            t_list = tasks_by_section[s_id]
            
            for t_name, duration in t_list:
                t_id = f"TSK_{task_id_count:05d}"
                mem = random.choice([m for m in members if m['section_id'] == s_id])
                end_date = current_date + timedelta(days=duration - 1)
                
                progress = random.choice([0, 20, 50, 80, 100]) if i < 2 else 0
                if progress == 0:
                    status_id = "ST_001"
                elif progress == 100:
                    status_id = "ST_005"
                else:
                    status_id = random.choice(["ST_002", "ST_003"])

                tasks_out[s_id].append({
                    "task_id": t_id,
                    "release_id": r_id,
                    "char_id": c["char_id"],
                    "section_id": s_id,
                    "task_name": t_name,
                    "member_id": mem["member_id"],
                    "start_date": current_date.strftime("%Y-%m-%d"),
                    "end_date": end_date.strftime("%Y-%m-%d"),
                    "progress": progress,
                    "lane": "",
                    "dependencies": prev_task_id if prev_task_id else "",
                    "status_id": status_id
                })
                
                prev_task_id = t_id
                current_date = end_date + timedelta(days=1)
                task_id_count += 1
            
            # セクション完了後、数日空けてデッドラインを設定
            current_date = current_date + timedelta(days=1)
            deadline_date = current_date
            
            deadlines_out.append({
                "release_id": r_id,
                "char_id": c["char_id"],
                "section_id": s_id,
                "deadline_date": deadline_date.strftime("%Y-%m-%d")
            })
            
            # デッドラインの翌日から次のセクション開始
            current_date = current_date + timedelta(days=1)

        # 背景班のタスク（独立して2Dの直後くらいに開始とする）
        bg_start = r_start + timedelta(days=20)
        bg_prev_task_id = None
        for t_name, duration in tasks_by_section["S_005"]:
            t_id = f"TSK_{task_id_count:05d}"
            mem = random.choice([m for m in members if m['section_id'] == "S_005"])
            bg_end = bg_start + timedelta(days=duration - 1)
            
            progress = random.choice([0, 20, 50, 80, 100]) if i < 2 else 0
            if progress == 0:
                status_id = "ST_001"
            elif progress == 100:
                status_id = "ST_005"
            else:
                status_id = random.choice(["ST_002", "ST_003"])

            tasks_out["S_005"].append({
                "task_id": t_id,
                "release_id": r_id,
                "char_id": c["char_id"],
                "section_id": "S_005",
                "task_name": t_name,
                "member_id": mem["member_id"],
                "start_date": bg_start.strftime("%Y-%m-%d"),
                "end_date": bg_end.strftime("%Y-%m-%d"),
                "progress": progress,
                "lane": "",
                "dependencies": bg_prev_task_id if bg_prev_task_id else "",
                "status_id": status_id
            })
            bg_prev_task_id = t_id
            bg_start = bg_end + timedelta(days=1)
            task_id_count += 1
            
        deadlines_out.append({
            "release_id": r_id,
            "char_id": c["char_id"],
            "section_id": "S_005",
            "deadline_date": bg_start.strftime("%Y-%m-%d")
        })

        if current_date > release_max_date:
            release_max_date = current_date
            
    # リリースのart_deadlineを最終セクションの少し後に設定
    releases.append({
        "release_id": r_id,
        "release_name": ver,
        "art_deadline": (release_max_date + timedelta(days=5)).strftime("%Y-%m-%d"),
        "event_name": f"Event_{i+1:03d}"
    })


def save_csv(path, data, fieldnames):
    with open(path, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(data)

save_csv(os.path.join(BASE_DIR, 'm_release.csv'), releases, ["release_id", "release_name", "art_deadline", "event_name"])
save_csv(os.path.join(BASE_DIR, 'm_character.csv'), characters, ["char_id", "char_name", "costume_name", "category", "usage", "event_id"])
save_csv(os.path.join(BASE_DIR, 'm_section.csv'), sections, ["section_id", "section_name", "color"])
save_csv(os.path.join(BASE_DIR, 'm_member.csv'), members, ["member_id", "member_name", "display_name", "section_id", "bg_color", "text_color"])
save_csv(os.path.join(BASE_DIR, 'm_status.csv'), statuses, ["status_id", "status_name", "color"])

for s_id, t_data in tasks_out.items():
    save_csv(os.path.join(BASE_DIR, f't_tasks_{s_id}.csv'), t_data, ["task_id", "release_id", "char_id", "section_id", "task_name", "member_id", "start_date", "end_date", "progress", "lane", "dependencies", "status_id"])

save_csv(os.path.join(BASE_DIR, 't_section_deadlines.csv'), deadlines_out, ["release_id", "char_id", "section_id", "deadline_date"])

print("Data generation completed successfully!")
