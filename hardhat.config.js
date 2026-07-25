/**
 * Configuration minimale : hardhat n'est utilise que pour fournir un noeud
 * EVM local en developpement (`npx hardhat node`). La compilation du contrat
 * passe par `solc` et le deploiement par `ethers` (scripts/).
 */
module.exports = {
  networks: {
    hardhat: { chainId: 31337, mining: { auto: true } },
  },
};
