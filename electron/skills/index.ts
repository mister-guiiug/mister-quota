// Skill registry. Each connector implements the Skill interface and returns
// data conforming to the §6 standard format. Add new providers here.

import type { Skill } from '../../shared/types';
import { cursorSkill } from './cursor';
import { claudeSkill } from './claude';
import { openaiSkill } from './openai';
import { genericManualSkill } from './generic';

export const SKILLS: Skill[] = [cursorSkill, claudeSkill, openaiSkill, genericManualSkill];

export function findSkill(id: string): Skill | undefined {
  return SKILLS.find((s) => s.id === id);
}
