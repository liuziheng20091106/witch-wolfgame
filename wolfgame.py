"""狼人杀游戏主逻辑。

该模块负责初始化游戏状态、驱动夜晚与白天流程、调用 AI 生成发言与决策，
并把结果通过 UI 展示给玩家。
"""

import os
import random
import re

import pygame
from dotenv import load_dotenv

from ai_agent import AIAgent
from ui_pygame import WolfGameUI

load_dotenv()


class WolfGame:
    """负责管理一局狼人杀的完整流程。

    该类负责维护玩家状态、夜晚行动、白天发言、投票和胜负判断，
    并通过 AI 与 UI 组合完成游戏交互。
    """

    def __init__ (self, ui=None):
        """创建一局新游戏并初始化所有基础状态。

        参数:
            ui: 可选的 UI 实例；若未提供，则创建默认界面。
        """

        # 初始化基础游戏状态与角色信息
        # 玩家人数
        num_players = 6
        # wolf 数量
        num_wolf = 2
        # 可用的 soul_id 列表（0..14）
        available_souls = list(range(0, 15))
        # 从 15 个角色中随机抽取 6 个 soul_id
        chosen_souls = random.sample(available_souls, num_players)

        # 角色分配（游戏内身份）
        Identity = ["wolf", "wolf", "seer", "witch", "villager", "villager"]
        random.shuffle(Identity)

        # self.players 中存储 game 内 id（0..5）与对应的 soul_id（0..14）
        self.players = []
        for game_id, soul_id in enumerate(chosen_souls):
            identity = Identity[game_id]
            player = {
                'id': game_id,       # 游戏内编号
                'soul_id': soul_id,   # 对应 souls/ 的文件编号
                'identity': identity,
                'alive': True
            }
            self.players.append(player)
        # 天数
        self.day = 0
        # 夜晚死亡情况
        self.night_deaths = []
        # 女巫是否还有解药
        self.witch_has_antidote = True
        # 女巫是否还有毒药
        self.witch_has_poison = True
        # 女巫救过谁（玩家ID）
        self.witch_saved = None
        # 女巫毒过谁（玩家ID）
        self.witch_poisoned = None
        # 预言家查验的玩家编号
        self.seer_checked = {}
        # 游戏是否结束
        self.game_over = False
        # AI 发言存储
        self.current_speeches = []
        # 历史发言存储
        self.history_speeches = []
        # 死亡日志
        self.death_log = []
        # 狼人内部讨论
        self.wolf_discussion_summary = ""
        # AI 代理
        self.ai_agent = AIAgent()
        # UI 代理
        self.ui = ui if ui is not None else WolfGameUI(num_players=6)
        # 给 UI 注入按 soul_id 加载的名字与头像
        for p in self.players:
            soul_id = p['soul_id']
            # 加载角色名
            try:
                import json as _json
                with open(f"souls/{soul_id}.json", "r", encoding="utf-8") as f:
                    data = _json.load(f)
                    name = data.get('name', f"{soul_id}号")
            except Exception:
                name = f"{soul_id}号"

            # 载入立绘图片（按 soul_id）并传给 UI
            try:
                avatar = pygame.image.load(f"images/avatar_{soul_id}.png")
                avatar = pygame.transform.scale(avatar, (70, 70))
            except Exception:
                avatar = None

            # 将名称与头像绑定到 UI 的 game index 上
            self.ui.set_player_name_by_index(p['id'], name)
            if avatar:
                self.ui.set_player_avatar_by_index(p['id'], avatar)

        # 把身份显示信息设置到 UI
        self._set_initial_ui_info()
        # 发言顺序
        self.speech_order = None 

        # 打印每个游戏内玩家对应的 soul_id、角色名与身份，便于调试
        for p in self.players:
            soul_id = p['soul_id']
            identity = p['identity']
            try:
                with open(f"souls/{soul_id}.json", "r", encoding="utf-8") as f:
                    data = __import__('json').load(f)
                    name = data.get('name', f"{soul_id}号")
            except Exception:
                name = f"{soul_id}号"
            print(f"game_id={p['id']} -> soul_id={soul_id}, name={name}, identity={identity}")

    def _set_initial_ui_info (self):
        """把玩家身份映射到 UI 上，便于界面显示角色名称。"""
        role_names_ui = {
            "wolf": "狼人",
            "villager": "村民",
            "seer": "预言家",
            "witch": "女巫"
        }
        for p in self.players:
            self.ui.set_player_info(p['id'], role_names_ui.get(p['identity'], p['identity']))

    def _get_alive_players (self):
        """返回当前仍然存活的玩家列表。"""
        return [p for p in self.players if p['alive']]

    def _get_wolf_players (self, alive_players=None):
        alive_players = self._get_alive_players() if alive_players is None else alive_players
        return [p for p in alive_players if p['identity'] == 'wolf']

    def _get_good_players (self, alive_players=None):
        alive_players = self._get_alive_players() if alive_players is None else alive_players
        return [p for p in alive_players if p['identity'] != 'wolf']

    def _get_player_by_id (self, player_id, alive_players=None):
        alive_players = self._get_alive_players() if alive_players is None else alive_players
        return next((p for p in alive_players if p['id'] == player_id), None)

    def _build_role_name_map (self):
        return {
            "wolf": "狼人",
            "villager": "村民",
            "seer": "预言家",
            "witch": "女巫"
        }

    def _get_role_display_name (self, identity):
        return self._build_role_name_map().get(identity, identity)

    def moderator_speech(self, content):
        """向 UI 发言区添加主持旁白。

        作用是把主持人的提示、规则和结果显示到界面上，方便玩家观察。
        """
        lines = content.split("\n")
        for line in lines:
            if line.strip():
                self.ui.display_speech(-1, f"【主持】{line}")

    def _build_wolf_discussion_prompt (self, wolf, wolf_players, alive_players):
        alive_ids = [p['id'] for p in alive_players]
        prompt = f"你是玩家 {wolf['id']}（狼人）。你的狼队友是：{[p['id'] for p in wolf_players if p['id'] != wolf['id']]}。"
        prompt += f" 当前存活玩家编号：{alive_ids}。"
        prompt += " 请根据白天的发言，提出你今晚最想杀的玩家编号。只输出数字，不要其他内容。"
        return prompt

    def _build_wolf_decision_prompt (self, decision_maker, wolf_players, alive_players, discussion_summary):
        prompt = f"你是玩家 {decision_maker['id']}（狼人代表）。你的狼队友是：{[p['id'] for p in wolf_players if p['id'] != decision_maker['id']]}。"
        prompt += f" 当前存活玩家编号：{[p['id'] for p in alive_players]}。"
        prompt += f" 狼队内部讨论摘要：\n{discussion_summary}\n"
        prompt += " 请根据讨论结果和你的判断，选择今晚最终要杀的目标玩家编号。只输出数字。"
        return prompt

    def _resolve_target_from_ai_response (self, response, alive_players):
        try:
            target_id = int(response.strip())
            return next((p for p in alive_players if p['id'] == target_id and p['identity'] != 'wolf'), None)
        except:
            return None

    def _pick_random_good_player (self, alive_players):
        good_players = self._get_good_players(alive_players)
        if good_players:
            return random.choice(good_players)
        return None

    def wolf_discussion(self):
        """狼人之间进行内部讨论，并选择今晚的最终目标。

        该方法会先让非代表狼人给出各自建议，再由代表综合讨论摘要做出最终决定。
        """
        alive_players = self._get_alive_players()
        wolf_players = self._get_wolf_players(alive_players)
        
        if len(wolf_players) <= 1:
            return "", None
        
        decision_maker = wolf_players[0]
        other_wolves = wolf_players[1:]
        
        suggestions = []
        for wolf in other_wolves:
            prompt = self._build_wolf_discussion_prompt(wolf, wolf_players, alive_players)
            response = self.ai_agent.call_api(prompt, temperature=0.3, max_tokens=5)
            target = self._resolve_target_from_ai_response(response, alive_players)
            if target:
                suggestions.append(f"玩家{wolf['id']}建议杀{target['id']}号")
            else:
                suggestions.append(f"玩家{wolf['id']}未提出有效建议")
        
        discussion_summary = "狼队内部讨论：\n"
        if suggestions:
            discussion_summary += "\n".join(suggestions)
        else:
            discussion_summary += "狼队尚未达成一致意见。"
        
        self.wolf_discussion_summary = discussion_summary
        
        prompt = self._build_wolf_decision_prompt(decision_maker, wolf_players, alive_players, discussion_summary)
        response = self.ai_agent.call_api(prompt, temperature=0.3, max_tokens=5)
        final_target = self._resolve_target_from_ai_response(response, alive_players)
        if final_target:
            return discussion_summary, final_target
        return discussion_summary, self._pick_random_good_player(alive_players)

    def wolf_action(self, target=None):
        """执行狼人夜间行动。

        如果已经有讨论后的目标，则直接使用；否则由 AI 根据局势选择目标。
        """
        alive_players = self._get_alive_players()
        wolf_players = self._get_wolf_players(alive_players)

        if not wolf_players:
            return None

        if target is not None and target in alive_players and target['identity'] != 'wolf':
            print(f"狼人（讨论后）杀死了玩家 {target['id']}")
            return target

        decision_maker = wolf_players[0]
        good_players = self._get_good_players(alive_players)
        if not good_players:
            return None

        target = self.ai_agent.choose_target(
            good_players,
            decision_maker['id'],
            'kill',
            self.players,
            self.night_deaths,
            self.history_speeches
        )
        print(f"狼人杀死了玩家 {target['id']}")
        return target

    def _build_witch_prompt (self, target, alive_players, alive_ids):
        prompt = f"你是女巫。你{'有' if self.witch_has_antidote else '没有'}解药，{'有' if self.witch_has_poison else '没有'}毒药。"
        prompt += f" 当前存活玩家编号：{alive_ids}。"
        prompt += f" 狼人今晚的目标是：{target['id']}。"

        if self.history_speeches:
            prompt += " 白天的全部发言记录如下：\n"
            for s in self.history_speeches:
                prompt += f"玩家{s['player_id']}号说：{s['content']}\n"

        prompt += " 请决定你的行动。注意：你可以在同一晚使用解药和毒药，但不能对同一个玩家既救又毒。"
        prompt += " 尽可能保证你要救的玩家是好人，毒的玩家是狼人。"
        prompt += " 提示：如果你无法确认要毒的对象是狼人，最好不要使用毒药，以免误伤好人。"
        prompt += " 提示：由于首夜晚上只有狼人可能动刀，所以最好在首夜晚上使用解药救人。大概率会是好人。"
        prompt += " 格式严格为：救/不救, 毒/不毒, 目标编号。例如：救, 毒, 3。如果不用毒，目标编号写0。"
        return prompt

    def _parse_witch_response (self, response):
        if response is None:
            if self.day == 1 and self.witch_has_antidote:
                return True, False, None
            return False, False, None

        parts = response.replace('，', ',').split(',')
        should_save = parts[0].strip() == '救' if len(parts) > 0 else False
        should_poison = parts[1].strip() == '毒' if len(parts) > 1 else False
        poison_target_id = None
        if should_poison and len(parts) > 2:
            numbers = re.findall(r'\d+', parts[2])
            if numbers:
                poison_target_id = int(numbers[0])
        return should_save, should_poison, poison_target_id

    def witch_action(self, target):
        """处理女巫的夜间行动，包含解药和毒药的选择。

        返回值表示狼人目标是否最终死亡：True 表示未被救，False 表示被救回。
        """
        # 女巫的回合同时处理救人和毒人的选择
        if target is None:
            return True
        
        alive_players = self._get_alive_players()
        witch = [p for p in alive_players if p['identity'] == 'witch']
        if not witch:
            return True
        
        witch_id = witch[0]['id']
        alive_ids = [p['id'] for p in alive_players]

        prompt = self._build_witch_prompt(target, alive_players, alive_ids)
        response = self.ai_agent.call_api(prompt, temperature=0.6, max_tokens=20)
        should_save, should_poison, poison_target_id = self._parse_witch_response(response)

        if should_save and self.witch_has_antidote:
            self.witch_has_antidote = False
            self.witch_saved = target['id']
            print(f"女巫使用解药救回了玩家 {target['id']}")
            target_saved = True
        else:
            target_saved = False

        if should_poison and self.witch_has_poison and poison_target_id is not None:
            poison_target = next((p for p in alive_players if p['id'] == poison_target_id and p['id'] != witch_id), None)
            if poison_target:
                self.witch_has_poison = False
                self.witch_poisoned = poison_target_id
                self._poison_death = poison_target
                print(f"女巫使用毒药毒死了玩家 {poison_target_id}")
            else:
                print(f"女巫毒药目标无效，未使用毒药")
                self._poison_death = None
        else:
            self._poison_death = None

        return not target_saved

    def seer_action(self):
        alive_players = self._get_alive_players()
        seer = [p for p in alive_players if p['identity'] == 'seer']

        if not seer:
            return

        targets = [p for p in alive_players if p['id'] != seer[0]['id']]
        if targets:
            target = self.ai_agent.choose_target(
                targets,
                seer[0]['id'],
                'check',
                self.players,
                self.night_deaths,
                self.history_speeches
            )
            self.seer_checked[target['id']] = target['identity']
            self.moderator_speech(f"预言家查验了 {target['id']} 号的身份，为 {target['identity']}。")

    def _get_wolf_checked_player (self):
        for pid, role in self.seer_checked.items():
            player = self.players[pid]
            if player['alive'] and role == 'wolf':
                return player
        return None

    def _build_speeches_for_vote (self, wolf_checked):
        speeches_for_vote = list(self.history_speeches) if self.history_speeches else []
        if wolf_checked:
            extra_speech = {
                "player_id": -1,
                "content": f"预言家昨晚查验了玩家 {wolf_checked['id']}，确认他是狼人！"
            }
            speeches_for_vote.append(extra_speech)
        return speeches_for_vote

    def _resolve_vote_target_id (self, result, alive_players, voter_id):
        if result == -1:
            return -1
        elif isinstance(result, dict) and result.get('alive') and result['id'] in [p['id'] for p in alive_players]:
            return result['id']
        else:
            print(f"玩家 {voter_id} 投票异常，自动转为弃权")
            return -1

    def _build_vote_detail (self, vote_counts):
        vote_detail = ""
        for pid, count in vote_counts.items():
            if pid != 'abstain':
                vote_detail += f"{pid}号{count}票，"
        if vote_counts.get('abstain', 0) > 0:
            vote_detail += f"弃权{vote_counts['abstain']}票"
        return vote_detail

    def vote_action(self):
        """执行白天投票流程，决定谁被放逐。"""
        alive_players = self._get_alive_players()

        self.ui.set_alive_status(alive_players)
        
        if not alive_players:
            return

        wolf_checked = self._get_wolf_checked_player()
        speeches_for_vote = self._build_speeches_for_vote(wolf_checked)

        vote_counts = {'abstain': 0}

        for voter in alive_players:
            candidates = [p for p in alive_players if p['id'] != voter['id']]
            if not candidates:
                vote_counts['abstain'] += 1
                print(f"玩家 {voter['id']} 是唯一存活者，自动弃权")
                continue

            result = self.ai_agent.choose_target(
                candidates,
                voter['id'],
                'vote',
                self.players,
                self.night_deaths,
                speeches_for_vote
            )

            target_id = self._resolve_vote_target_id(result, alive_players, voter['id'])

            if target_id == -1:
                vote_counts['abstain'] += 1
                print(f"玩家 {voter['id']} 选择弃权")
            else:
                vote_counts[target_id] = vote_counts.get(target_id, 0) + 1
                print(f"玩家 {voter['id']} 投票给了 {target_id}")

        player_votes = {k: v for k, v in vote_counts.items() if k != 'abstain'}
        if not player_votes:
            print("所有人弃权，今天无人被放逐（平安日）")
            return

        max_player_votes = max(player_votes.values())
        abstain_votes = vote_counts['abstain']

        if abstain_votes >= max_player_votes:
            print(f"弃权票数 {abstain_votes} 不小于最高票 {max_player_votes}，无人被放逐（平安日）")
            return

        top_candidates = [pid for pid, v in player_votes.items() if v == max_player_votes]
        voted_out_id = random.choice(top_candidates)
        voted_out = self.players[voted_out_id]
        voted_out['alive'] = False
        self.death_log.append({"player_id": voted_out_id, "cause": "vote_out"})

        vote_detail = self._build_vote_detail(vote_counts)
        self.moderator_speech(f"投票结果：{vote_detail}")

        if len(top_candidates) > 1:
            tie_str = "、".join([str(pid) for pid in top_candidates])
            self.moderator_speech(f"{tie_str}号与平票，随机处刑了 {voted_out_id} 号！")
        else:
            self.moderator_speech(f"{voted_out_id} 号被投票处刑！")

    def night_phase(self):
        """执行夜晚阶段：狼人行动、女巫反应、预言家查验。"""

        # 夜晚阶段依次执行狼人行动、女巫行动和预言家查验
        self.night_deaths = []
        self.moderator_speech("天黑了，请各位小魔女闭眼。")

        alive_players = self._get_alive_players()
        wolf_players = self._get_wolf_players(alive_players)

        self.ui.set_alive_status(alive_players)
        
        if len(wolf_players) > 1:
            discussion_summary, final_target = self.wolf_discussion()
            if final_target is not None:
                print("狼队讨论摘要：")
                print(discussion_summary)
                target = final_target
            else:
                target = self.wolf_action()
        else:
            target = self.wolf_action()

        is_dead = self.witch_action(target)

        if target and is_dead:
            target['alive'] = False
            self.night_deaths.append(target)
            self.death_log.append({"player_id": target['id'], "cause": "wolf_kill"})
            self.moderator_speech(f"狼人杀死了 {target['id']} 号")
        elif target and not is_dead:
            self.moderator_speech(f"狼人想要杀死 {target['id']} 号，但女巫使用解药救回了她")
        else:
            print("狼人今晚没有行动")

        if hasattr(self, '_poison_death') and self._poison_death:
            self._poison_death['alive'] = False
            self.night_deaths.append(self._poison_death)
            self.moderator_speech(f"女巫使用毒药杀死了 {self._poison_death['id']} 号。")

        self.seer_action()

    def day_phase(self):
        """执行白天阶段：公布死亡情况、发言并进行投票。"""

        self.moderator_speech("天亮了，请各位小魔女睁眼。")
        if self.night_deaths:
            death_ids = [p['id'] for p in self.night_deaths]
            death_text = "、".join(map(str, death_ids))
            self.moderator_speech(f"昨晚 {death_text} 号被杀死。")
        else:
            self.moderator_speech("昨晚是平安夜，没有人死亡。")

        alive_players = self._get_alive_players()
        self.ui.set_alive_status(alive_players)
        self.moderator_speech(f"存活玩家: {[p['id'] for p in alive_players]}")

        self.moderator_speech("小魔女们请开始自由发言环节~")
        self.speech_phase()

        if len (alive_players) > 0:
            self.moderator_speech("发言完毕，开始投票，票数最高的魔女将被处刑！")
            self.vote_action()

    def _build_death_summary (self):
        if not self.death_log:
            return ""
        death_summary = "历史死亡记录：\n"
        for entry in self.death_log:
            player = self.players[entry['player_id']]
            cause_text = "被狼人杀死" if entry['cause'] == "wolf_kill" else "被投票放逐"
            death_summary += f"- 玩家{entry['player_id']} {cause_text}\n"
        return death_summary

    def _build_speech_context (self, speeches, death_summary):
        context = ""
        if speeches:
            context = "\n".join([f"{s['player_id']}号说：{s['content']}" for s in speeches])

        if death_summary:
            context = death_summary + (context if context else "")
        return context

    def _build_extra_rule (self, player):
        if player['identity'] == 'seer':
            checked_info = []
            for pid, role in self.seer_checked.items():
                if self.players[pid]['alive']:
                    checked_info.append(f"你查验了玩家 {pid}，真实身份是：{role}。")
            if checked_info:
                real_info = "\n".join(checked_info)
                return f"【系统强制规则】你是预言家。你的真实查验记录如下：\n{real_info}\n如果你认为查验结果对好人有利，你需要在本次发言中如实报告这些查验结果，不得编造或隐瞒。其他分析内容（如怀疑对象、归票建议）可以自由发挥。如果你认为查验结果不利于好人，你可以选择不报告查验结果，以免暴露自己的神职身份\n提示：利于好人不止是发金水，或者验狼，也包括你自己的存活状态，由于你是游戏里最重要的神职角色之一，请仔细考虑自己发言对好人阵营和自己的利弊。如果你报假查杀，好人阵营会失去对信息的信任，你也会被怀疑是狼人。"
            return "【系统强制规则】你是预言家，但到目前为止你尚未查验任何玩家，你可以在发言中说明这一点，并分析局势。"

        if player['identity'] == 'witch':
            witch_info = []
            if self.witch_saved is not None:
                witch_info.append(f"你曾经救过玩家 {self.witch_saved}。")
            if self.witch_poisoned is not None:
                witch_info.append(f"你曾经毒过玩家 {self.witch_poisoned}。")
            if self.witch_has_antidote:
                witch_info.append("你还有解药。")
            if self.witch_has_poison:
                witch_info.append("你还有毒药。")
            if witch_info:
                extra_rule = "【系统强制规则】你是女巫。你的行动记录如下：\n" + "\n".join(witch_info) + "\n"
                extra_rule += "【特别提醒】你必须在发言中如实反映你的行动记录，不得编造或否认自己使用过的药水。"
                extra_rule += "如果你认为这些事实不利于好人，你可以选择不主动提及它们，但不能说假话，否则好人会对你的信任度下降，甚至怀疑你是狼人。"
                return extra_rule
            return "【系统强制规则】你是女巫，你尚未使用任何药水。"

        if player['identity'] == 'wolf':
            if self.wolf_discussion_summary:
                return f"【系统强制规则】你们狼队的内部讨论摘要如下：\n{self.wolf_discussion_summary}\n你在发言时可以参考这些信息，但不要泄露你们讨论过，以免暴露狼队身份。"
            return "【系统强制规则】你是狼人，注意隐藏身份，不要暴露队友。"

        return ""

    def speech_phase(self):
        """白天发言环节：按发言顺序依次生成每位玩家的发言。"""
        print("\n===== 发言环节 =====")
        speeches = []
        
        for p in self.speech_order:
            if not p['alive']:
                continue

            death_summary = self._build_death_summary()
            context = self._build_speech_context(speeches, death_summary)
            extra_rule = self._build_extra_rule(p)

            speech = self.ai_agent.generate_speech(
                p['id'], 
                self.players, 
                self.day, 
                self.night_deaths, 
                context,
                extra_rule
            )
            self.ui.display_speech(p['id'], speech)
            self.ui.set_current_speaker(p['id'])
            print(f"玩家 {p['id']} 说：{speech}")
            speeches.append({"player_id": p['id'], "content": speech})
        
        self.current_speeches = speeches
        self.history_speeches.extend(speeches)
        print("===== 发言环节结束 =====")

    def check_game_over (self):
        """检查当前局面是否已经出现胜负结果。"""
        alive_players = self._get_alive_players()
        wolf_count = sum (1 for p in alive_players if p['identity'] == 'wolf')
        villager_count = sum (1 for p in alive_players if p['identity'] != 'wolf')

        if wolf_count == 0:
            self.moderator_speech("游戏结束，好人阵营胜利！恭喜胜利的小魔女们~")
            self.game_over = True
        elif villager_count == 0:
            self.moderator_speech("游戏结束，狼人阵营胜利！恭喜胜利的小魔女们~")
            self.game_over = True

    def _build_identity_summary (self):
        identity_list = []
        for p in self.players:
            role_text = self._get_role_display_name(p['identity'])
            identity_list.append(f"{p['id']}号：{role_text}")
        return "本局身份分配如下：\n" + "\n".join(identity_list)

    def _initialize_speech_order (self):
        alive_players = self._get_alive_players()
        self.speech_order = alive_players[:]
        random.shuffle(self.speech_order)
        return self.speech_order

    def run (self):
        """启动主游戏循环，直到一方获胜。"""

        # 主游戏循环：夜晚 -> 检查胜负 -> 白天 -> 检查胜负
        self.moderator_speech("欢迎各位小魔女们来到魔女狼人杀！")
        self._initialize_speech_order()

        order_str = "、".join([str(p['id']) for p in self.speech_order])
        self.moderator_speech(f"本场游戏发言顺序：{order_str}")

        identity_summary = self._build_identity_summary()
        self.moderator_speech(identity_summary)

        while True:
            self.day += 1
            print (f"\n==== 第 {self.day} 天 ====")

            self.night_phase ()
            self.check_game_over ()
            if self.game_over:
                break

            self.day_phase ()
            self.check_game_over ()
            if self.game_over:
                break

if __name__ == "__main__":
    import threading
    import time
    from ui_pygame import WolfGameUI

    ui = WolfGameUI(num_players=6)
    game = WolfGame(ui)
    game_thread = threading.Thread(target=game.run, daemon=True)
    game_thread.start()

    while ui.running and not game.game_over:
        ui.update()
        time.sleep(0.02)

    if game.game_over:
        ui.show_close_button = True
        game.moderator_speech("点击右下角【关闭游戏】按钮即可退出游戏。")
        while ui.running:
            ui.update()
            time.sleep(0.05)

    ui.running = False
    pygame.quit()
    print("窗口已关闭")