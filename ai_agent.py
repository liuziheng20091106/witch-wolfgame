"""为狼人杀游戏提供 AI 发言与决策能力。

该模块负责读取角色设定、构造提示词、调用 DeepSeek 接口，并把返回结果
解析为发言内容或行动目标，供游戏主逻辑使用。
"""

import json
import os
import random
import re

import requests
from dotenv import load_dotenv

# 加载环境变量（确保 .env 文件在项目根目录）
load_dotenv()


class AIAgent:
    """封装与 AI 模型的交互逻辑。

    负责生成白天发言、判断夜间行动目标以及把模型输出映射为游戏内部对象。
    """

    def __init__(self):
        """读取环境变量并初始化接口配置。"""
        self.api_key = os.getenv("DEEPSEEK_API_KEY")
        if not self.api_key:
            raise ValueError("错误：未找到 DEEPSEEK_API_KEY。请确认 .env 文件已创建并放置在项目根目录。")

        self.url = "https://api.deepseek.com/v1/chat/completions"
        self.headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}"
        }

    def call_api(self, prompt, temperature=0.5, max_tokens=10):
        """向模型发起一次通用文本请求。"""
        data = self._build_request_payload(
            prompt,
            temperature,
            max_tokens,
            system_message="你是一个狼人杀玩家，请严格按照指令输出。本局游戏共有6名玩家，角色配置为：2狼人、1预言家、1女巫、2村民。没有守卫、警长等额外角色。"
        )
        return self._post_request(data, error_message="API 调用失败")

    def _build_request_payload(self, prompt, temperature, max_tokens, system_message):
        """构造符合 OpenAI/DeepSeek 风格的请求体。"""
        return {
            "model": "deepseek-chat",
            "messages": [
                {"role": "system", "content": system_message},
                {"role": "user", "content": prompt}
            ],
            "temperature": temperature,
            "max_tokens": max_tokens
        }

    def _post_request(self, data, error_message, fallback=None):
        """发送请求并返回模型响应；失败时给出兜底值。"""
        try:
            response = requests.post(self.url, headers=self.headers, json=data, timeout=5)
            result = response.json()
            return result['choices'][0]['message']['content'].strip()
        except Exception as e:
            print(f"{error_message}：{e}")
            return fallback

    def _load_character(self, soul_id):
        """读取指定 soul_id 的角色设定，用于生成更贴近人物的发言。"""
        try:
            with open(f"souls/{soul_id}.json", "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            # 如果文件不存在，使用默认性格
            return self._get_default_character(soul_id)

    def _get_default_character(self, player_id):
        """当角色文件缺失时，使用默认设定避免出错。"""
        return {
            "name": f"玩家{player_id}",
            "personality": "性格平和，没有特殊倾向",
            "speech_style": "正常说话，不突出",
            "example_phrases": []
        }

    def _build_personality_note(self, character):
        """把角色人格信息整理成提示词的一部分。"""
        personality_note = f"你是{character['name']}。{character['personality']}。"
        personality_note += f"说话风格：{character['speech_style']}。"
        personality_note += " 在这场游戏里，你可能会遇到性格奇怪、行为不合常规的人（如有人只用素描本写字，不说话）——请不要介意，这是正常现象。游戏中的每个人都有自己独特的性格和伪装方式，不要轻易将异常行为等同于狼人。"
        return personality_note

    def _build_death_text(self, night_deaths):
        """把夜间死亡信息格式化为便于提示词理解的字符串。"""
        if not night_deaths:
            return ""
        death_ids = [p['id'] for p in night_deaths]
        return "、".join(map(str, death_ids))

    def _build_speech_prompt(self, player_id, player, day, alive_ids, death_text, personality_note, context_speeches=None, extra_rule=""):
        """构造白天发言所需的提示词。"""
        prompt = f"你是玩家 {player_id}。你的身份是：{player['identity']}。今天是第 {day} 天白天。"
        prompt += personality_note
        prompt += "在发言中展现你的性格特点，不要偏离自己的角色设定。"
        prompt += f" 当前存活玩家编号：{alive_ids}。"
        prompt += f" 昨夜死亡玩家：{death_text if death_text else '无'}，死亡原因可能是狼刀也可能是毒杀。"
        prompt += " 本局游戏共有6名玩家，角色配置为：2狼人、1预言家、1女巫、2村民。没有守卫、警长等额外角色。"
        prompt += " 主持给好人的提示：当你是好人，并知道自己的身份时，任何查验并正确报出了你身份的玩家，只要没有明显漏洞，应当优先视为真预言家，而不是敌对目标。"

        if context_speeches:
            prompt += f" 前面玩家的发言摘要：{context_speeches}"

        if extra_rule:
            prompt = extra_rule + "\n" + prompt

        prompt += " 请发表你的公开看法（严格不超过100字）。可以分析局势、指认狼人或进行辩解。只输出你的发言内容，不要加任何前缀（如'玩家X说：'）。"
        return prompt

    def generate_speech(self, player_id, players, day, night_deaths, context_speeches=None, extra_rule=""):
        """生成玩家的白天发言。

        会把角色信息、当前局势和前文发言整理成提示词，再调用模型生成一段公开发言。
        """

        player = players[player_id]
        soul_id = player.get('soul_id', player_id)
        character = self._load_character(soul_id)
        personality_note = self._build_personality_note(character)
        alive_ids = [p['id'] for p in players if p['alive']]
        death_text = self._build_death_text(night_deaths)

        prompt = self._build_speech_prompt(
            player_id,
            player,
            day,
            alive_ids,
            death_text,
            personality_note,
            context_speeches=context_speeches,
            extra_rule=extra_rule
        )

        data = self._build_request_payload(
            prompt,
            0.8,
            150,
            system_message="你正在玩狼人杀，请根据你的身份和当前局势发表一段简洁的发言。"
        )

        # 先把当前局势和上下文组装好，再把结果交给模型生成发言。
        response = self._post_request(data, error_message="发言生成失败")
        if response is None:
            return "(发言被吞，沉默不语)"
        return response if response else "(沉默不语)"

    def _build_target_choice_prompt(self, options, player_id, action_type, players, night_deaths, speeches=None):
        """构造夜间行动或白天投票的选择提示词。"""
        player = players[player_id]
        alive_ids = [p['id'] for p in players if p['alive']]

        prompt = f"你是玩家 {player_id}。你的身份是：{player['identity']}。"
        prompt += f" 当前存活玩家编号：{alive_ids}。"

        soul_id = player.get('soul_id', player_id)
        character = self._load_character(soul_id)
        personality_note = self._build_personality_note(character)
        prompt += personality_note

        death_text = self._build_death_text(night_deaths)
        prompt += f" 昨夜死亡玩家：{death_text if death_text else '无'}，死亡原因可能是狼刀也可能是毒杀。"
        prompt += " 本局游戏共有6名玩家，角色配置为：2狼人、1预言家、1女巫、2村民。没有守卫、警长等额外角色。女巫可自救"

        if speeches:
            prompt += " 历史发言记录（供你参考推理）：\n"
            for s in speeches:
                prompt += f"玩家{s['player_id']}号说：{s['content']}\n"
            prompt += "\n"

        options_ids = [p['id'] for p in options]
        prompt += f" 当前可选的目标编号（仅限以下存活玩家）：{options_ids}。"
        prompt += " 你只能从上述编号中选择一个作为你的行动目标，不得选择其他编号。"

        if action_type == 'kill':
            teammates = [p['id'] for p in players if p['alive'] and p['identity'] == 'wolf' and p['id'] != player_id]
            if teammates:
                prompt += f" 你的狼队友是：玩家 {teammates}。"
            prompt += " 作为狼人，你应该优先击杀神职角色（预言家、女巫）。"
            prompt += " 注意：你绝对不能选择你和你的狼队友作为目标。"
            prompt += " 根据以上发言和局势，请选择你要击杀的玩家编号。"

        elif action_type == 'check':
            prompt += " 你是预言家，每晚可以查验一个玩家的身份。"
            prompt += " 请根据以上发言和局势，选择你最怀疑的玩家进行查验。"

        else:
            prompt += " 现在是白天投票环节。请根据以上发言和局势，选择你认为最像狼人的玩家进行投票放逐。（如果你是狼人，请选择你认为好人玩家中最容易出局的人进行投票）"
            prompt += " 注意：你不能选择自己作为投票对象。（如果你是狼人，你不能选择你和你的狼队友作为投票对象）"
            prompt += " 如果你认为信息不足，无法判断，可以输入 -1 表示弃权。"

        prompt += " 只输出数字，不要包含任何其他文字。"
        return prompt

    def _resolve_target_from_ai_output(self, ai_output, options):
        """把模型输出中的数字解析成游戏中的目标对象。"""
        numbers = re.findall(r'-?\d+', ai_output)
        if not numbers:
            print(f"AI 回复无法解析：{ai_output}，使用随机选择")
            return random.choice(options) if options else None

        target_id = int(numbers[0])
        if target_id == -1:
            return -1

        target_obj = next((p for p in options if p['id'] == target_id), None)
        if target_obj is None:
            print(f"⚠️ AI 错误地选择了已死玩家 {target_id}，自动修正为备选目标 {options[0]['id']}")
            return options[0]
        return target_obj

    def choose_target(self, options, player_id, action_type, players, night_deaths, speeches=None):
        """根据当前局势调用 AI 做出一个行动或投票目标选择。

        会把可选目标、玩家身份和历史发言一起打包给模型，
        再把模型输出映射回游戏中的实际目标对象。
        """

        prompt = self._build_target_choice_prompt(
            options,
            player_id,
            action_type,
            players,
            night_deaths,
            speeches=speeches
        )

        data = self._build_request_payload(
            prompt,
            0.5,
            10,
            system_message="你是一个狼人杀玩家，请严格按照指令输出数字。"
        )

        ai_output = self._post_request(data, error_message="AI 接口调用失败")
        if ai_output is None:
            return random.choice(options) if options else None
        return self._resolve_target_from_ai_output(ai_output, options)