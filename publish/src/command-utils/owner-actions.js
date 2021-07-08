'use strict';

const ethers = require('ethers');
const { gray, yellow } = require('chalk');

const { logTx } = require('./ui-utils');

const {
	getSafeInstance,
	getSafeNonce,
	getSafeTransactions,
	checkExistingPendingTx,
	getNewTransactionHash,
	saveTransactionToApi,
	getSafeSignature,
} = require('./safe-utils');

const {
	getMultisigInstance,
	getMultisigTransactionIds,
	getMultisigTxCount,
	checkMultisigExistingPendingTx,
	submitMultisigTransaction,
} = require('./multisig-utils');

const KIND = { safe: 'SAFE', legacy: 'LEGACY', eoa: 'EAO' };

const getSignerData = async ({ signerKind, providerUrl, newOwner }) => {
	const signerData = {};
	if (signerKind === KIND.safe) {
		// new owner should be gnosis safe proxy address
		signerData.protocolDaoContract = getSafeInstance(providerUrl, newOwner);

		// get protocolDAO nonce
		signerData.currentSafeNonce = await getSafeNonce(signerData.protocolDaoContract);

		if (!signerData.currentSafeNonce) {
			console.log(gray('Cannot access safe. Exiting.'));
			process.exit();
		}

		console.log(
			yellow(`Using Protocol DAO Safe contract at ${signerData.protocolDaoContract.address}`)
		);
	}

	if (signerKind === KIND.legacy) {
		signerData.multisigContract = getMultisigInstance({ providerUrl, newOwner });
	}

	return signerData;
};

const getStagedTransactions = async ({ signerKind, signerData, network }) => {
	let stagedTransactions;
	if (signerKind === KIND.safe) {
		stagedTransactions = await getSafeTransactions({
			network,
			safeAddress: signerData.protocolDaoContract.address,
		});
	}

	if (signerKind === KIND.legacy) {
		const lastTx = await getMultisigTxCount(signerData.multisigContract);

		stagedTransactions = await getMultisigTransactionIds({
			network,
			multisigContract: signerData.multisigContract,
			from: 0, // Do we need to get all from 0 or can we reduce the number?
			to: lastTx,
			pending: true, // Only getting pending transacions
			executed: false,
		});
	}

	return stagedTransactions;
};

const txAlreadyExists = async ({
	signerKind,
	signerData,
	stagedTransactions,
	target,
	encodedData,
}) => {
	if (signerKind === KIND.safe) {
		return checkExistingPendingTx({
			stagedTransactions,
			target,
			encodedData,
			currentSafeNonce: signerData.currentSafeNonce,
		});
	}

	if (signerKind === KIND.legacy) {
		const tx = await checkMultisigExistingPendingTx({
			multisigContract: signerData.multisigContract,
			stagedTransactions: signerData.stagedTransactions,
			target,
			encodedData,
		});
		return tx;
	}

	return false;
};

const acceptOwnershipBySigner = async ({
	signerKind,
	signerData,
	useFork,
	network,
	privateKey,
	providerUrl,
	encodedData,
	to,
	wallet,
	gasLimit,
	gasPrice,
}) => {
	if (signerKind === KIND.safe && !useFork) {
		const { txHash, newNonce } = await getNewTransactionHash({
			safeContract: signerData.protocolDaoContract,
			data: encodedData,
			to,
			sender: wallet.address,
			network,
			lastNonce: signerData.lastNonce,
		});

		// sign txHash to get signature
		const sig = getSafeSignature({
			privateKey,
			providerUrl,
			contractTxHash: txHash,
		});

		// save transaction and signature to Gnosis Safe API
		await saveTransactionToApi({
			safeContract: signerData.protocolDaoContract,
			network,
			data: encodedData,
			nonce: newNonce,
			to,
			sender: wallet.address,
			transactionHash: txHash,
			signature: sig,
		});

		// track lastNonce submitted
		signerData.lastNonce = newNonce;
		return;
	}

	if (signerKind === KIND.legacy) {
		const receipt = await submitMultisigTransaction({
			multisigContract: signerData.multisigContract,
			network,
			wallet,
			to,
			value: ethers.constants.Zero,
			data: encodedData,
			gasPrice,
			gasLimit,
		});
		logTx(receipt);
		return;
	}

	// SignerKind is not contract type or using fork for Gnosis Safe
	const params = {
		to,
		gasPrice: ethers.utils.parseUnits(gasPrice, 'gwei'),
		data: encodedData,
	};
	if (gasLimit) {
		params.gasLimit = ethers.BigNumber.from(gasLimit);
	}

	const tx = await wallet.sendTransaction(params);
	const receipt = await tx.wait();

	logTx(receipt);
};

module.exports = {
	KIND,
	getSignerData,
	getStagedTransactions,
	txAlreadyExists,
	acceptOwnershipBySigner,
};