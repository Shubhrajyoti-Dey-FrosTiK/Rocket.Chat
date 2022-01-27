import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Accounts } from 'meteor/accounts-base';

import * as Mailer from '../../../mailer';
import { callbacks } from '../../../../lib/callbacks';
import { relinquishRoomOwnerships } from './relinquishRoomOwnerships';
import { closeOmnichannelConversations } from './closeOmnichannelConversations';
import { shouldRemoveOrChangeOwner, getSubscribedRoomsForUserWithDetails } from './getRoomsWithSingleOwner';
import { getUserSingleOwnedRooms } from './getUserSingleOwnedRooms';
import { settings } from '../../../settings/server/functions/settings';
import { Rooms, Subscriptions, Users } from '../../../models/server';
import { IUser, IUserEmail } from '../../../../definition/IUser';
import { IRoom } from '../../../../definition/IRoom';

function reactivateDirectConversations(userId: string): void {
	// since both users can be deactivated at the same time, we should just reactivate rooms if both users are active
	// for that, we need to fetch the direct messages, fetch the users involved and then the ids of rooms we can reactivate
	const directConversations: IRoom[] = Rooms.getDirectConversationsByUserId(userId, {
		projection: { _id: 1, uids: 1 },
	}).fetch();
	const userIds = directConversations.flatMap((r) => r.uids);
	const uniqueUserIds = [...new Set(userIds)];
	const activeUsers = Users.findActiveByUserIds(uniqueUserIds, { projection: { _id: 1 } }).fetch();
	const activeUserIds = activeUsers.map((u: IUser) => u._id);
	const roomsToReactivate = directConversations.reduce((acc, room: IRoom) => {
		const otherUserId = room.uids.find((u) => u !== userId);
		if (activeUserIds.includes(otherUserId)) {
			acc.push(room._id);
		}
		return acc;
	}, [] as string[]);

	Rooms.setDmReadOnlyByUserId(userId, roomsToReactivate, false, false);
}

export async function setUserActiveStatus(userId: string, active: boolean, confirmRelinquish = false): Promise<boolean> {
	check(userId, String);
	check(active, Boolean);

	const user = Users.findOneById(userId);

	if (!user) {
		return false;
	}

	// Users without username can't do anything, so there is no need to check for owned rooms
	if (user.username != null && !active) {
		const userAdmin = Users.findOneAdmin(userId);
		const adminsCount = Users.findActiveUsersInRoles(['admin']).count();
		if (userAdmin && adminsCount === 1) {
			throw new Meteor.Error('error-action-not-allowed', 'Leaving the app without an active admin is not allowed', {
				method: 'removeUserFromRole',
				action: 'Remove_last_admin',
			});
		}

		const subscribedRooms = getSubscribedRoomsForUserWithDetails(userId);
		// give omnichannel rooms a special treatment :)
		const chatSubscribedRooms = subscribedRooms.filter(({ t }) => t !== 'l');
		const livechatSubscribedRooms = subscribedRooms.filter(({ t }) => t === 'l');

		if (shouldRemoveOrChangeOwner(chatSubscribedRooms) && !confirmRelinquish) {
			const rooms = getUserSingleOwnedRooms(chatSubscribedRooms);
			throw new Meteor.Error('user-last-owner', '', rooms);
		}

		closeOmnichannelConversations(user, livechatSubscribedRooms);
		await relinquishRoomOwnerships(user, chatSubscribedRooms, false);
	}

	if (active && !user.active) {
		callbacks.run('beforeActivateUser', user);
	}

	Users.setUserActive(userId, active);

	if (active && !user.active) {
		callbacks.run('afterActivateUser', user);
	}

	if (!active && user.active) {
		callbacks.run('afterDeactivateUser', user);
	}

	if (user.username) {
		Subscriptions.setArchivedByUsername(user.username, !active);
	}

	if (active === false) {
		Users.unsetLoginTokens(userId);
		Rooms.setDmReadOnlyByUserId(userId, undefined, true, false);
	} else {
		Users.unsetReason(userId);
		reactivateDirectConversations(userId);
	}
	if (active && !settings.get('Accounts_Send_Email_When_Activating')) {
		return true;
	}
	if (!active && !settings.get('Accounts_Send_Email_When_Deactivating')) {
		return true;
	}

	const destinations =
		Array.isArray(user.emails) && user.emails.map((email: IUserEmail) => `${user.name || user.username}<${email.address}>`);

	const { userActivated } = Accounts.emailTemplates as unknown as {
		userActivated: {
			subject({ active, username }: { active: boolean; username?: string }): string;

			html({ active, name, username }: { active: boolean; name: string; username: string }): string;
		};
	};

	const email = {
		to: String(destinations),
		from: String(settings.get('From_Email')),
		subject: userActivated.subject({ active }),
		html: userActivated.html({
			active,
			name: user.name,
			username: user.username,
		}),
	};

	Mailer.sendNoWrap(email);
	return false;
}