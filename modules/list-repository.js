// All new list writes pass through RLS or invoker RPCs. No service-role key is used.
import { normalizeCards, normalizeListName } from './card-data.js';
export function listRepository(supabase) {
  return {
    async create(name, cards) {
      const { data, error } = await supabase.rpc('create_shopping_list', {
        p_name: normalizeListName(name), p_cards: normalizeCards(cards, { allowEmpty: true })
      });
      if (error) throw error;
      if (!data) throw Error('The server did not return a list ID.');
      return data;
    },
    async add(listId, card, merge) {
      const { data, error } = await supabase.rpc('add_shopping_list_item', {
        p_list_id: listId, p_card: normalizeCards([card])[0], p_merge: Boolean(merge)
      });
      if (error) throw error;
      if (!data) throw Error('The server did not return an item ID.');
      return data;
    },
    async remove(listId, itemId) {
      const { data, error } = await supabase.from('shopping_list_items').delete()
        .eq('id', itemId).eq('list_id', listId).select('id');
      if (error) throw error;
      if (data?.length !== 1) throw Error('Item was not removed. It may already be deleted or access was denied.');
    },
    async saveProfile(userId, displayName) {
      const name = String(displayName).trim();
      if (!name || name.length > 60) throw Error('Display name must be 1–60 characters.');
      const { data, error } = await supabase.from('wishclaw_profiles')
        .upsert({ user_id: userId, display_name: name }, { onConflict: 'user_id' }).select().single();
      if (error) throw error;
      return data;
    }
  };
}
