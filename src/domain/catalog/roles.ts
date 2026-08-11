import type { Alignment, RoleId } from '../model';

export const roleNames: Record<RoleId, string> = {
  wolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  villager: '村民',
};

export const roleDescriptions: Record<RoleId, string> = {
  wolf: '与狼队协作，每夜选择一名好人袭击。狼人达到好人人数时获胜。',
  seer: '每夜查验一名其他存活者的当前职业。',
  witch: '拥有一瓶解药与一瓶毒药，每种整局只能使用一次。',
  villager: '依靠公开发言、投票与魔女技找出狼人。',
};

export const roleAlignment: Record<RoleId, Alignment> = {
  wolf: 'wolf',
  seer: 'good',
  witch: 'good',
  villager: 'good',
};
