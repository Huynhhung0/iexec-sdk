const Debug = require('debug');
const { Observable, SafeObserver } = require('./reactive');
const dealModule = require('./deal');
const taskModule = require('./task');
const {
  getAuthorization,
  download,
  NULL_ADDRESS,
  sleep,
  FETCH_INTERVAL,
} = require('./utils');
const { getAddress } = require('./wallet');
const { bytes32Schema, throwIfMissing } = require('./validator');
const { ObjectNotFoundError } = require('./errors');

const debug = Debug('iexec:process');

const downloadFromIpfs = async (
  ipfsAddress,
  { ipfsGatewayURL = 'https://gateway.ipfs.io' } = {},
) => {
  try {
    debug(
      'downloadFromIpfs()',
      'ipfsGatewayURL',
      ipfsGatewayURL,
      'ipfsAddress',
      ipfsAddress,
    );
    const res = await download('GET')(ipfsAddress, {}, {}, ipfsGatewayURL);
    return res;
  } catch (error) {
    throw Error(`Failed to download from ${ipfsGatewayURL}: ${error.message}`);
  }
};

const downloadFromResultRepo = async (contracts, taskid, task, userAddress) => {
  const resultRepoBaseURL = task.results.split(`${taskid}`)[0];
  const authorization = await getAuthorization(
    contracts.chainId,
    userAddress,
    contracts.jsonRpcProvider,
    { apiUrl: resultRepoBaseURL },
  );
  const res = await download('GET')(
    taskid,
    { chainId: contracts.chainId },
    { authorization },
    resultRepoBaseURL,
  );
  return res;
};

const fetchTaskResults = async (
  contracts = throwIfMissing(),
  taskid = throwIfMissing(),
  { ipfsGatewayURL } = {},
) => {
  try {
    const vTaskId = await bytes32Schema().validate(taskid);
    const userAddress = await getAddress(contracts);
    const task = await taskModule.show(contracts, vTaskId);
    if (task.status !== 3) throw Error('Task is not completed');

    const tasksDeal = await dealModule.show(contracts, task.dealid);
    if (
      userAddress.toLowerCase() !== tasksDeal.beneficiary.toLowerCase()
      && NULL_ADDRESS !== tasksDeal.beneficiary.toLowerCase()
    ) {
      throw Error(
        `Only beneficiary ${tasksDeal.beneficiary} can download the result`,
      );
    }
    const resultAddress = task.results;
    let res;
    if (resultAddress && resultAddress.substr(0, 6) === '/ipfs/') {
      debug('download from ipfs', resultAddress);
      res = await downloadFromIpfs(resultAddress, { ipfsGatewayURL });
    } else if (resultAddress && resultAddress.substr(0, 2) !== '0x') {
      debug('download from result repo', resultAddress);
      res = await downloadFromResultRepo(contracts, vTaskId, task, userAddress);
    } else {
      throw Error('No result uploaded for this task');
    }
    return res;
  } catch (error) {
    debug('fetchResults()', error);
    throw error;
  }
};

const obsTaskMessages = {
  TASK_STATUS_UPDATE: 'TASK_STATUS_UPDATE',
  TASK_COMPLETED: 'TASK_COMPLETED',
  TASK_TIMEOUT: 'TASK_TIMEOUT',
  TASK_FAILED: 'TASK_FAILED',
};

const obsTask = (
  contracts = throwIfMissing(),
  taskid = throwIfMissing(),
  { dealid } = {},
) => new Observable((observer) => {
  let stop = false;
  const safeObserver = new SafeObserver(observer);

  const startWatch = async () => {
    try {
      const vTaskid = await bytes32Schema().validate(taskid);
      const vDealid = await bytes32Schema().validate(dealid);
      debug('vTaskid', vTaskid);
      debug('vDealid', vDealid);

      const handleTaskNotFound = async (e) => {
        if (e instanceof ObjectNotFoundError && vDealid) {
          const deal = await dealModule.show(contracts, vDealid);
          const now = Math.floor(Date.now() / 1000);
          const deadlineReached = now >= deal.finalTime.toNumber();
          return {
            taskid: vTaskid,
            dealid: vDealid,
            status: 0,
            statusName: deadlineReached
              ? taskModule.TASK_STATUS_MAP.timeout
              : taskModule.TASK_STATUS_MAP[0],
            taskTimedOut: deadlineReached,
          };
        }
        throw e;
      };

      const waitStatusChangeOrTimeout = async initialStatus => taskModule
        .waitForTaskStatusChange(contracts, vTaskid, initialStatus)
        .catch(async (e) => {
          const task = await handleTaskNotFound(e);
          if (
            task.status === initialStatus
                && !task.taskTimedOut
                && !stop
          ) {
            await sleep(FETCH_INTERVAL);
            return waitStatusChangeOrTimeout(task.status);
          }
          return task;
        });

      const watchTask = async (initialStatus = '') => {
        const task = await waitStatusChangeOrTimeout(initialStatus);
        debug('task', task);
        if (task.status === 3) {
          safeObserver.next({
            message: obsTaskMessages.TASK_COMPLETED,
            task,
          });
          safeObserver.complete();
          return;
        }
        if (task.status === 4) {
          safeObserver.next({
            message: obsTaskMessages.TASK_FAILED,
            task,
          });
          safeObserver.complete();
          return;
        }
        if (task.taskTimedOut) {
          safeObserver.next({
            message: obsTaskMessages.TASK_TIMEOUT,
            task,
          });
          safeObserver.complete();
          return;
        }
        safeObserver.next({
          message: obsTaskMessages.TASK_STATUS_UPDATE,
          task,
        });
        if (!stop) await watchTask(task.status);
      };
      await watchTask();
    } catch (e) {
      safeObserver.error(e);
    }
  };

  safeObserver.unsub = () => {
    // teardown callback
    stop = true;
  };
  startWatch();
  return safeObserver.unsubscribe.bind(safeObserver);
});

module.exports = {
  fetchTaskResults,
  obsTask,
};
