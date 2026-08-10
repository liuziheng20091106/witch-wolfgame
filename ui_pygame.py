"""狼人杀游戏的 Pygame 用户界面。

该模块负责展示发言记录、玩家状态、当前发言者以及关闭按钮，
并通过队列与游戏主线程进行异步通信。
"""

import json
import queue
import sys

import pygame

WHITE = (255, 255, 255)
BLACK = (0, 0, 0)
GRAY = (200, 200, 200)
DARK_GRAY = (50, 50, 50)
YELLOW = (255, 255, 100)
PLAYER_COLORS = [
    (255, 180, 180),  # 0号
    (180, 255, 180),  # 1号
    (180, 180, 255),  # 2号
    (255, 255, 180),  # 3号
    (255, 180, 255),  # 4号
    (180, 255, 255),  # 5号
]


class WolfGameUI:
    """负责渲染狼人杀界面并处理用户交互。

    UI 主要分为两部分：左侧发言记录面板和右侧玩家状态面板，
    通过队列接收游戏逻辑发来的更新内容。
    """

    def __init__(self, num_players=6):
        """初始化窗口、字体、资源和内部状态。"""
        pygame.init()
        self.num_players = num_players
        self.running = True

        self.width = 1100
        self.height = 700
        self.screen = pygame.display.set_mode((self.width, self.height))
        pygame.display.set_caption("魔女狼人杀")
        self.LABEL_HEIGHT = 32  # 固定标签高度，模拟和绘制共用

        self._load_window_icon()
        self._load_fonts()
        self._load_avatars()
        self._load_player_names()

        # ---------- 玩家身份存储 ----------
        self.player_roles = ["未知"] * num_players
        # ---------------------------------

        # ---------- 队列 ----------
        self.speech_queue = queue.Queue()
        self.status_queue = queue.Queue()
        self.speaker_queue = queue.Queue()

        self.speeches = []
        self.current_speaker = None
        self.alive_status = [True] * num_players
        self.scroll_offset = 0
        self._need_scroll_bottom = False

        self.clock = pygame.time.Clock()
        # ---------- 关闭按钮 ----------
        self.close_button_rect = pygame.Rect(
            self.width - 160,
            self.height - 55,
            130,
            40
        )
        self.close_button_text = "关闭游戏"
        self.show_close_button = False
        self.game_over = False

    def _load_window_icon(self):
        """尝试加载窗口图标；失败时静默忽略。"""
        try:
            icon_surface = pygame.image.load("images/icon.ico")
            icon_size = (64, 64)
            icon_surface = pygame.transform.smoothscale(icon_surface, icon_size)
            pygame.display.set_icon(icon_surface)
        except Exception as e:
            print(f"图标加载失败: {e}")

    def _load_fonts(self):
        """加载中文字体，优先使用项目自带字体。"""
        font_path = "Fonts/zh-cn.ttf"
        try:
            self.font = pygame.font.Font(font_path, 18)
            self.font_small = pygame.font.Font(font_path, 14)
            self.font_large = pygame.font.Font(font_path, 22)
        except Exception:
            try:
                self.font = pygame.font.Font("C:/Windows/Fonts/msyh.ttc", 18)
                self.font_small = pygame.font.Font("C:/Windows/Fonts/msyh.ttc", 14)
                self.font_large = pygame.font.Font("C:/Windows/Fonts/msyh.ttc", 22)
            except Exception:
                self.font = pygame.font.Font(None, 18)
                self.font_small = pygame.font.Font(None, 14)
                self.font_large = pygame.font.Font(None, 22)

    def _load_avatars(self):
        """读取玩家头像；缺失时使用颜色方块兜底。"""
        self.avatars = []
        for i in range(self.num_players):
            try:
                img = pygame.image.load(f"images/avatar_{i}.png")
                img = pygame.transform.scale(img, (70, 70))
                self.avatars.append(img)
            except Exception:
                surf = pygame.Surface((70, 70))
                surf.fill(PLAYER_COLORS[i % len(PLAYER_COLORS)])
                self.avatars.append(surf)

    def _load_player_names(self):
        """从角色配置文件中加载玩家名称。

        注意：UI 层的名字和头像优先由游戏逻辑通过 `set_player_name_by_index`
        与 `set_player_avatar_by_index` 传入（使用 soul_id），这里保留一个
        基础的占位列表以便回退。
        """
        self.player_names = [f"{i}号" for i in range(self.num_players)]

    def set_player_name_by_index(self, index, name):
        """按 UI 中的 index (game_id) 设置显示名称。"""
        if 0 <= index < self.num_players and name:
            self.player_names[index] = name

    def set_player_avatar_by_index(self, index, avatar_surface):
        """按 UI 中的 index (game_id) 设置玩家头像 Surface。"""
        if 0 <= index < self.num_players and avatar_surface is not None:
            self.avatars[index] = avatar_surface

    def set_player_info(self, player_id, role):
        """设置玩家的身份，用于右侧面板显示。"""
        if 0 <= player_id < self.num_players:
            self.player_roles[player_id] = role

    def update(self):
        """主线程调用：每帧处理事件、队列和渲染。"""
        if not self.running:
            return

        self._handle_events()
        self._process_queues()
        self._render()
        self.clock.tick(15)

    def _handle_events(self):
        """处理鼠标、关闭窗口和滚动事件。"""
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                self.running = False
                pygame.quit()
                sys.exit()

            if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                if self.show_close_button and self.close_button_rect.collidepoint(event.pos):
                    self.running = False
                    pygame.quit()
                    sys.exit()

            if event.type == pygame.MOUSEWHEEL:
                self.scroll_offset += event.y * 20
                max_scroll = max(0, len(self.speeches) * 45 - 400)
                if self.scroll_offset > 0:
                    self.scroll_offset = 0
                if self.scroll_offset < -max_scroll:
                    self.scroll_offset = -max_scroll

    def _process_queues(self):
        """从线程安全队列读取最新的发言、状态和发言者信息。"""
        processed = 0
        while processed < 1 and not self.speech_queue.empty():
            player_id, content = self.speech_queue.get()
            self.speeches.append({"player_id": player_id, "content": content})
            processed += 1
            self._need_scroll_bottom = True

        while not self.status_queue.empty():
            self.alive_status = self.status_queue.get()

        while not self.speaker_queue.empty():
            self.current_speaker = self.speaker_queue.get()

    def _render(self):
        """把当前状态绘制到窗口上。"""
        self.screen.fill(DARK_GRAY)

        speech_x, speech_y = 20, 20
        speech_width = self.width * 2 // 3 - 40
        self._render_speech_panel(speech_x, speech_y, speech_width)

        right_x = speech_x + speech_width + 20
        right_y = 20
        right_width = self.width - right_x - 20
        right_height = self.height - 40
        self._render_player_panel(right_x, right_y, right_width, right_height)

        self._render_close_button()
        pygame.display.flip()

    def _render_speech_panel(self, speech_x, speech_y, speech_width):
        """绘制左侧发言记录面板，并支持滚动查看历史发言。"""
        pygame.draw.rect(self.screen, WHITE, (speech_x, speech_y, speech_width, self.height - 40), border_radius=10)
        title = self.font_large.render("💬 发言记录", True, BLACK)
        self.screen.blit(title, (speech_x + 20, speech_y + 10))

        title_height = 50
        clip_rect = pygame.Rect(speech_x, speech_y + title_height, speech_width, self.height - 40 - title_height)
        self.screen.set_clip(clip_rect)

        temp_y = speech_y + title_height
        for speech in self.speeches:
            label_w, label_h = self._get_speech_label_info(speech.get("player_id", -1))
            max_line_width = speech_width - (label_w + 40)
            lines = self._wrap_text(speech["content"], max_line_width)
            text_height = len(lines) * 20 if lines else 0
            block_height = max(label_h, text_height)
            temp_y += block_height
            temp_y += 10
            temp_y += 10

        total_height = temp_y - (speech_y + title_height)
        visible_height = (self.height - 40) - title_height
        max_scroll = max(0, total_height - visible_height)

        if self._need_scroll_bottom:
            self.scroll_offset = -max_scroll
            self._need_scroll_bottom = False
        if self.scroll_offset > 0:
            self.scroll_offset = 0
        if self.scroll_offset < -max_scroll:
            self.scroll_offset = -max_scroll

        y_offset = speech_y + title_height + self.scroll_offset

        for speech in self.speeches:
            player_id = speech["player_id"]
            content = speech["content"]
            label_w, label_h = self._get_speech_label_info(player_id)
            if player_id == -1:
                color = (200, 200, 200)
                label_text = "主持"
                label_surf = self.font_small.render(label_text, True, BLACK)
                label_w = label_surf.get_width() + 10
                label_h = label_surf.get_height() + 4
                label_bg = pygame.Surface((label_w, label_h))
                label_bg.fill(color)
                self.screen.blit(label_bg, (speech_x + 20, y_offset - 2))
                self.screen.blit(label_surf, (speech_x + 25, y_offset))
            else:
                color = PLAYER_COLORS[player_id % len(PLAYER_COLORS)]
                name = self.player_names[player_id] if player_id < len(self.player_names) else f"{player_id}号"
                role = self.player_roles[player_id] if player_id < len(self.player_roles) else "???"
                name_surf = self.font_small.render(name, True, BLACK)
                role_surf = self.font_small.render(role, True, (80, 80, 80))
                name_h = name_surf.get_height()
                role_h = role_surf.get_height()
                label_w = max(name_surf.get_width(), role_surf.get_width()) + 16
                label_h = name_h + role_h + 8
                label_bg = pygame.Surface((label_w, label_h))
                label_bg.fill(color)
                self.screen.blit(label_bg, (speech_x + 20, y_offset - 2))
                self.screen.blit(name_surf, (speech_x + 28, y_offset + 2))
                self.screen.blit(role_surf, (speech_x + 28, y_offset + 2 + name_h))

            text_start_x = speech_x + 20 + label_w + 10
            if player_id == -1:
                name_h = self.font_small.get_height()
            text_start_y = y_offset + 2

            max_line_width = speech_width - (label_w + 40)
            lines = self._wrap_text(content, max_line_width)

            text_y = text_start_y
            for line in lines:
                text_surf = self.font.render(line, True, BLACK)
                self.screen.blit(text_surf, (text_start_x, text_y))
                text_y += 20

            text_height = len(lines) * 20 if lines else 0
            block_height = max(label_h, text_height)
            y_offset += block_height
            y_offset += 10
            pygame.draw.line(self.screen, GRAY, (speech_x + 20, y_offset), (speech_x + speech_width - 20, y_offset), 1)
            y_offset += 10

        self.screen.set_clip(None)

    def _get_speech_label_info(self, player_id):
        if player_id == -1:
            label_h = self.font_small.get_height() + 4
            label_w = self.font_small.size("主持")[0] + 10
            return label_w, label_h

        name = self.player_names[player_id] if player_id < len(self.player_names) else f"{player_id}号"
        role = self.player_roles[player_id] if player_id < len(self.player_roles) else "???"
        name_w = self.font_small.size(name)[0]
        role_w = self.font_small.size(role)[0]
        label_w = max(name_w, role_w) + 16
        name_h = self.font_small.get_height()
        role_h = self.font_small.get_height()
        label_h = name_h + role_h + 8
        return label_w, label_h

    def _wrap_text(self, content, max_line_width):
        if not content:
            return []

        lines = []
        line = ""
        for char in content:
            test_line = line + char
            if self.font.size(test_line)[0] < max_line_width:
                line = test_line
            else:
                if line:
                    lines.append(line)
                line = char
        if line:
            lines.append(line)
        return lines

    def _render_player_panel(self, right_x, right_y, right_width, right_height):
        """绘制右侧玩家列表，显示头像、存活状态和身份。"""
        pygame.draw.rect(self.screen, WHITE, (right_x, right_y, right_width, right_height), border_radius=10)
        title = self.font_large.render("玩家", True, BLACK)
        self.screen.blit(title, (right_x + 20, right_y + 10))

        avatar_size = 70
        spacing = 10
        start_y = right_y + 50

        for i in range(self.num_players):
            x = right_x + 20
            y = start_y + i * (avatar_size + spacing + 15)

            alive = self.alive_status[i] if i < len(self.alive_status) else True
            alpha = 255 if alive else 100
            avatar = self.avatars[i].copy()
            if not alive:
                avatar.set_alpha(alpha)

            if i == self.current_speaker:
                pygame.draw.rect(self.screen, YELLOW, (x - 5, y - 5, avatar_size + 10, avatar_size + 10), 3, border_radius=5)
            else:
                pygame.draw.rect(self.screen, GRAY, (x - 2, y - 2, avatar_size + 4, avatar_size + 4), 1, border_radius=3)

            self.screen.blit(avatar, (x, y))

            status_text = "√" if alive else "×"
            name_text = self.player_names[i] if i < len(self.player_names) else f"{i}号"
            role_text = self.player_roles[i] if i < len(self.player_roles) else "???"
            display_text = f"{name_text} {status_text} {role_text}"
            label = self.font.render(display_text, True, BLACK)
            self.screen.blit(label, (x + avatar_size + 15, y + 25))

    def _render_close_button(self):
        """在游戏结束后显示关闭按钮，供用户退出界面。"""
        if not self.show_close_button:
            return

        pygame.draw.rect(self.screen, (200, 80, 80), self.close_button_rect, border_radius=8)
        pygame.draw.rect(self.screen, (255, 255, 255), self.close_button_rect, 2, border_radius=8)
        text = self.font.render(self.close_button_text, True, WHITE)
        text_rect = text.get_rect(center=self.close_button_rect.center)
        self.screen.blit(text, text_rect)

    # ---- 供游戏线程调用的方法（线程安全） ----
    def display_speech(self, player_id, content):
        """向界面追加一条发言。"""
        self.speech_queue.put((player_id, content))

    def set_current_speaker(self, player_id):
        """通知界面当前正在发言的玩家。"""
        self.speaker_queue.put(player_id)

    def set_alive_status(self, alive_list):
        """更新玩家存活状态，用于右侧列表高亮显示。"""
        if alive_list:
            status_dict = {p['id']: p['alive'] for p in alive_list}
            status_bool = [status_dict.get(i, False) for i in range(self.num_players)]
            self.status_queue.put(status_bool)
        else:
            self.status_queue.put([True] * self.num_players)

    def clear_speeches(self):
        """清空当前界面上的发言记录和待处理队列。"""
        self.speeches = []
        self.current_speaker = None
        self.scroll_offset = 0
        while not self.speech_queue.empty():
            self.speech_queue.get()
        while not self.speaker_queue.empty():
            self.speaker_queue.get()

    def close(self):
        """关闭界面循环。"""
        self.running = False
        # pygame.quit()