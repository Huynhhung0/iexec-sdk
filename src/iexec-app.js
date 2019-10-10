#!/usr/bin/env node

const cli = require('commander');
const {
  help,
  addGlobalOptions,
  addWalletLoadOptions,
  computeWalletLoadOptions,
  computeTxOptions,
  checkUpdate,
  handleError,
  desc,
  option,
  Spinner,
  pretty,
  info,
  isEthAddress,
} = require('./cli-helper');
const hub = require('./hub');
const {
  loadIExecConf,
  initObj,
  saveDeployedObj,
  loadDeployedObj,
} = require('./fs');
const { Keystore } = require('./keystore');
const { loadChain } = require('./chains');
const { NULL_ADDRESS } = require('./utils');

const objName = 'app';

const init = cli.command('init');
addGlobalOptions(init);
addWalletLoadOptions(init);
init.description(desc.initObj(objName)).action(async (cmd) => {
  await checkUpdate(cmd);
  const spinner = Spinner(cmd);
  try {
    const walletOptions = await computeWalletLoadOptions(cmd);
    const keystore = Keystore(
      Object.assign({}, walletOptions, { isSigner: false }),
    );
    const [address] = await keystore.accounts();
    const { saved, fileName } = await initObj(objName, {
      overwrite: { owner: address },
    });
    spinner.succeed(
      `Saved default ${objName} in "${fileName}", you can edit it:${pretty(
        saved,
      )}`,
      { raw: { app: saved } },
    );
  } catch (error) {
    handleError(error, cli, cmd);
  }
});

const deploy = cli.command('deploy');
addGlobalOptions(deploy);
addWalletLoadOptions(deploy);
deploy
  .option(...option.chain())
  .option(...option.txGasPrice())
  .description(desc.deployObj(objName))
  .action(async (cmd) => {
    await checkUpdate(cmd);
    const spinner = Spinner(cmd);
    try {
      const walletOptions = await computeWalletLoadOptions(cmd);
      const txOptions = computeTxOptions(cmd);
      const keystore = Keystore(walletOptions);
      const [chain, iexecConf] = await Promise.all([
        loadChain(cmd.chain, keystore, { spinner, txOptions }),
        loadIExecConf(),
      ]);
      if (!iexecConf[objName]) {
        throw Error(
          `Missing ${objName} in 'iexec.json'. Did you forget to run 'iexec ${objName} init'?`,
        );
      }
      await keystore.load();
      spinner.start(info.deploying(objName));
      const { address, txHash } = await hub.deployApp(
        chain.contracts,
        iexecConf[objName],
      );
      spinner.succeed(`Deployed new ${objName} at address ${address}`, {
        raw: { address, txHash },
      });
      await saveDeployedObj(objName, chain.id, address);
    } catch (error) {
      handleError(error, cli, cmd);
    }
  });

const show = cli.command('show [addressOrIndex]');
addGlobalOptions(show);
addWalletLoadOptions(show);
show
  .option(...option.chain())
  .option(...option.user())
  .description(desc.showObj(objName))
  .action(async (cliAddressOrIndex, cmd) => {
    await checkUpdate(cmd);
    const spinner = Spinner(cmd);
    try {
      const walletOptions = await computeWalletLoadOptions(cmd);
      const keystore = Keystore(
        Object.assign({}, walletOptions, { isSigner: false }),
      );
      const [chain, [address], deployedObj] = await Promise.all([
        loadChain(cmd.chain, keystore, { spinner }),
        keystore.accounts(),
        loadDeployedObj(objName),
      ]);

      const addressOrIndex = cliAddressOrIndex || deployedObj[chain.id];

      const isAddress = isEthAddress(addressOrIndex, { strict: false });
      const userAddress = cmd.user || (address !== NULL_ADDRESS && address);
      if (!isAddress && !userAddress) throw Error(`Missing option ${option.user()[0]} or wallet`);

      if (!addressOrIndex) throw Error(info.missingAddress(objName));
      spinner.start(info.showing(objName));

      let res;
      if (isAddress) {
        res = await hub.showApp(chain.contracts, addressOrIndex);
      } else {
        res = await hub.showUserApp(
          chain.contracts,
          addressOrIndex,
          userAddress,
        );
      }
      const { app, objAddress } = res;
      spinner.succeed(`${objName} ${objAddress} details:${pretty(app)}`, {
        raw: { address: objAddress, app },
      });
    } catch (error) {
      handleError(error, cli, cmd);
    }
  });

const count = cli.command('count');
addGlobalOptions(count);
addWalletLoadOptions(count);
count
  .option(...option.chain())
  .option(...option.user())
  .description(desc.countObj(objName))
  .action(async (cmd) => {
    await checkUpdate(cmd);
    const spinner = Spinner(cmd);
    const walletOptions = await computeWalletLoadOptions(cmd);
    const keystore = Keystore(
      Object.assign({}, walletOptions, { isSigner: false }),
    );
    try {
      const [chain, [address]] = await Promise.all([
        loadChain(cmd.chain, keystore, { spinner }),
        keystore.accounts(),
      ]);
      const userAddress = cmd.user || (address !== NULL_ADDRESS && address);
      if (!userAddress) throw Error(`Missing option ${option.user()[0]} or wallet`);
      spinner.start(info.counting(objName));
      const objCountBN = await hub.countUserApps(chain.contracts, userAddress);
      spinner.succeed(
        `User ${userAddress} has a total of ${objCountBN} ${objName}`,
        { raw: { count: objCountBN.toString() } },
      );
    } catch (error) {
      handleError(error, cli, cmd);
    }
  });

help(cli);
