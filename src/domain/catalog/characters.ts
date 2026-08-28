import { z } from 'zod';
import { CHARACTER_CATALOG } from '../../../shared/gamePromptContract.js';
import soul0 from '../../data/characters/0.json';
import soul1 from '../../data/characters/1.json';
import soul2 from '../../data/characters/2.json';
import soul3 from '../../data/characters/3.json';
import soul4 from '../../data/characters/4.json';
import soul5 from '../../data/characters/5.json';
import soul6 from '../../data/characters/6.json';
import soul7 from '../../data/characters/7.json';
import soul8 from '../../data/characters/8.json';
import soul9 from '../../data/characters/9.json';
import soul10 from '../../data/characters/10.json';
import soul11 from '../../data/characters/11.json';
import soul12 from '../../data/characters/12.json';
import soul13 from '../../data/characters/13.json';
import type { CharacterDefinition, CharacterId } from '../model';

const rawCharacterSchema = z.object({
  personality: z.string().min(1),
  speech_style: z.string().min(1),
  example_phrases: z.array(z.string().min(1)).min(1),
  decision_traits: z.object({
    conservative: z.number().min(0).max(1),
    trusting: z.number().min(0).max(1),
    aggressive: z.number().min(0).max(1),
  }),
});

const rawCharacters: unknown[] = [soul0, soul1, soul2, soul3, soul4, soul5, soul6, soul7, soul8, soul9, soul10, soul11, soul12, soul13];
const avatars = Array.from({ length: CHARACTER_CATALOG.length }, (_, index) => new URL(`../../assets/avatars/avatar_${index}.png`, import.meta.url).href);

export const characters: CharacterDefinition[] = rawCharacters.map((raw, index) => {
  const parsed = rawCharacterSchema.parse(raw);
  const catalogEntry = CHARACTER_CATALOG[index];
  const avatarUrl = avatars[index];
  if (!catalogEntry || !avatarUrl) {
    throw new Error(`角色目录索引 ${index} 不完整`);
  }
  return {
    id: catalogEntry.id,
    name: catalogEntry.name,
    personality: parsed.personality,
    speechStyle: parsed.speech_style,
    examplePhrases: parsed.example_phrases,
    decisionTraits: parsed.decision_traits,
    avatarUrl,
  };
});

if (new Set(characters.map((character) => character.id)).size !== characters.length) {
  throw new Error('角色目录包含重复 ID');
}

export const characterById = Object.fromEntries(
  characters.map((character) => [character.id, character]),
) as Record<CharacterId, CharacterDefinition>;
