#aws/services/eks.ts
import * as eks from "@pulumi/eks";
import * as aws from "@pulumi/aws";
import { VpcResource } from "./vpc";
//import { create } from "node:domain";
//import { stringToSubchannelAddress } from "@grpc/grpc-js/build/src/subchannel-address";

export class EksResource {
    public readonly cluster: eks.Cluster;
    public readonly instanceProfile: aws.iam.InstanceProfile;
    public readonly eksServiceRole: aws.iam.Role;
    public readonly provider: aws.Provider;
    public readonly ebsCsiAddon: aws.eks.Addon;
    //public readonly storageClass: k8s.storage.v1.StorageClass,

    constructor(name: string, vpc: VpcResource, region: string) {

        const managedPolicyArns: string[] = [
            "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
            "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
            "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
            "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy",
        ];

        this.provider = new aws.Provider(`${name}-provider`, {
            region: region,
        });

        // Cluster Role
        const eksClusterRole = new aws.iam.Role(`${name}-eks-cluster-role`, {
            assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
                Service: "eks.amazonaws.com",
            }),
        });

        new aws.iam.RolePolicyAttachment(`${name}-eks-cluster-policy`, {
            policyArn: "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
            role: eksClusterRole,
        });

        // Node Role (EC2)
        this.eksServiceRole = new aws.iam.Role(`${name}-eks-node-role`, {
            assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
                Service: "ec2.amazonaws.com",
            }),
        });

        managedPolicyArns.forEach((policy, index) => {
            new aws.iam.RolePolicyAttachment(`${name}-eks-node-policy-${index}`, {
                policyArn: policy,
                role: this.eksServiceRole,
            });
        });

        this.instanceProfile = new aws.iam.InstanceProfile(`${name}-eks-instance-profile`, {
            role: this.eksServiceRole,
        });

        //  EKS Cluster
        this.cluster = new eks.Cluster(name, {
            vpcId: vpc.vpc.id,
            subnetIds: vpc.privateSubnets.map(s => s.id),
            endpointPublicAccess: true,
            endpointPrivateAccess: true,
            version: "1.32",
            publicAccessCidrs: ["0.0.0.0/0"],
            skipDefaultNodeGroup: true,
            serviceRole: eksClusterRole,
            tags: {
                Name: name,
            }
        }, {
            provider: this.provider,
            dependsOn: [vpc.vpc],
        });

        // Node Group
        const nodeGroup = new aws.eks.NodeGroup(`${name}-nodegroup`, {
            clusterName: this.cluster.eksCluster.name,
            subnetIds: vpc.privateSubnets.map(s => s.id), 
            scalingConfig: {
                desiredSize: 3,
                minSize: 2,
                maxSize: 5,
            },
            instanceTypes: ["t2.micro"],
            nodeRoleArn: this.eksServiceRole.arn,
            labels: {
                instance: "t2.micro",
                type: "compute",
            },
        }, {
            provider: this.provider, 
            dependsOn: [this.cluster],
        });

        this.ebsCsiAddon = new aws.eks.Addon(`${name}-eks-add`, {
            clusterName: this.cluster.eksCluster.name,
            addonName: "aws-ebs-csi-driver",
            addonVersion: "v1.10.1-eksbuild.1",
            resolveConflictsOnCreate: "OVERWRITE",
            resolveConflictsOnUpdate: "OVERWRITE",
            tags:{
                Name: `${name}-eks-add`,
            },

        },{
            provider: this.provider,
            dependsOn: [nodeGroup],

        });
        //createStorageClass(name: string): k8s.storage.v1.StorageClass
    }
}
---
# aws/services/index.ts
export { VpcResource } from "./vpc"
export { EksResource } from "./eks"
---
aws/services/vpc.ts
import * as aws from "@pulumi/aws";
import { ProviderResource } from "@pulumi/pulumi";

export class VpcResource {
    public readonly name: string;
    public readonly region: string;
    public readonly cidrPrefix: string;

    public readonly vpc: aws.ec2.Vpc;

    public readonly publicSubnets: aws.ec2.Subnet[];
    public readonly privateSubnets: aws.ec2.Subnet[];

    public readonly publicRouteTable: aws.ec2.RouteTable;
    public readonly privateRouteTable: aws.ec2.RouteTable;

    public readonly publicRouteTableAssociations: aws.ec2.RouteTableAssociation[];
    public readonly privateRouteTableAssociations: aws.ec2.RouteTableAssociation[];

    public readonly igw: aws.ec2.InternetGateway;
    public readonly publicIgwRoute: aws.ec2.Route;

    public readonly natEip: aws.ec2.Eip;
    public readonly natGateway: aws.ec2.NatGateway;
    public readonly privateNatRoute: aws.ec2.Route;

    public readonly publicNacl: aws.ec2.NetworkAcl;
    public readonly privateNacl: aws.ec2.NetworkAcl;

    public readonly publicNaclAssociations: aws.ec2.NetworkAclAssociation[];
    public readonly privateNaclAssociations: aws.ec2.NetworkAclAssociation[];

    public readonly publicNaclRules: aws.ec2.NetworkAclRule[];
    public readonly privateNaclRules: aws.ec2.NetworkAclRule[];

    constructor(
        provider: ProviderResource,
        name: string,
        region: string = "ap-south-1",
        cidrPrefix: string = "10.0",
        environment: string = "qa",
    ) {
        this.name = name;
        this.region = region;
        this.cidrPrefix = cidrPrefix;

        const azs = [`${region}a`, `${region}b`, `${region}c`];
        const opts = { provider };

        // VPC
        this.vpc = new aws.ec2.Vpc(name, {
            cidrBlock: `${cidrPrefix}.0.0/16`,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            tags: {
                Name: name,
                Environment: environment,
            },
        }, opts);

        // Public Subnets
        this.publicSubnets = azs.map((az, index) =>
            new aws.ec2.Subnet(`${name}-public-sub-${az.slice(-2)}`, {
                vpcId: this.vpc.id,
                cidrBlock: `${cidrPrefix}.${index + 10}.0/24`,
                availabilityZone: az,
                mapPublicIpOnLaunch: true,
                tags: {
                    Name: `${name}-public-sub-${az.slice(-2)}`,
                    "kubernetes.io/role/elb": "1",
                },
            }, { ...opts, dependsOn: [this.vpc] })
        );

        // Private Subnets
        this.privateSubnets = azs.map((az, index) =>
            new aws.ec2.Subnet(`${name}-private-sub-${az.slice(-2)}`, {
                vpcId: this.vpc.id,
                cidrBlock: `${cidrPrefix}.${index + 1}.0/24`,
                availabilityZone: az,
                mapPublicIpOnLaunch: false,
                tags: {
                    Name: `${name}-private-sub-${az.slice(-2)}`,
                    "kubernetes.io/role/internal-elb": "1",
                },
            }, { ...opts, dependsOn: [this.vpc] })
        );

        // Internet Gateway
        this.igw = new aws.ec2.InternetGateway(`${name}-igw`, {
            vpcId: this.vpc.id,
            tags: { Name: `${name}-igw` },
        }, { ...opts, dependsOn: [this.vpc] });

        // Public Route Table
        this.publicRouteTable = new aws.ec2.RouteTable(`${name}-public-rt`, {
            vpcId: this.vpc.id,
            tags: { Name: `${name}-public-rt` },
        }, { ...opts, dependsOn: [this.igw] });

        // Public Route to IGW
        this.publicIgwRoute = new aws.ec2.Route(`${name}-public-igw-route`, {
            routeTableId: this.publicRouteTable.id,
            destinationCidrBlock: "0.0.0.0/0",
            gatewayId: this.igw.id,
        }, opts);

        // Elastic IP for NAT
        this.natEip = new aws.ec2.Eip(`${name}-nat-eip`, {
            domain: "vpc",
            tags: { Name: `${name}-nat-eip` },
        }, { ...opts, dependsOn: [this.igw] });

        // NAT Gateway (placed in first public subnet)
        this.natGateway = new aws.ec2.NatGateway(`${name}-nat`, {
            allocationId: this.natEip.id,
            subnetId: this.publicSubnets[0].id,
            tags: { Name: `${name}-nat` },
        }, { ...opts, dependsOn: [this.publicSubnets[0], this.natEip] });

        // Private Route Table
        this.privateRouteTable = new aws.ec2.RouteTable(`${name}-private-rt`, {
            vpcId: this.vpc.id,
            tags: { Name: `${name}-private-rt` },
        }, { ...opts, dependsOn: [this.natGateway] });

        // Private Route to NAT
        this.privateNatRoute = new aws.ec2.Route(`${name}-private-nat-route`, {
            routeTableId: this.privateRouteTable.id,
            destinationCidrBlock: "0.0.0.0/0",
            natGatewayId: this.natGateway.id,
        }, opts);

        // Route Table Associations
        this.publicRouteTableAssociations = this.publicSubnets.map((subnet, index) =>
            new aws.ec2.RouteTableAssociation(`${name}-pub-rt-assoc-${index + 1}`, {
                subnetId: subnet.id,
                routeTableId: this.publicRouteTable.id,
            }, opts)
        );

        this.privateRouteTableAssociations = this.privateSubnets.map((subnet, index) =>
            new aws.ec2.RouteTableAssociation(`${name}-pvt-rt-assoc-${index + 1}`, {
                subnetId: subnet.id,
                routeTableId: this.privateRouteTable.id,
            }, opts)
        );

        // Network ACLs
        this.publicNacl = new aws.ec2.NetworkAcl(`${name}-public-nacl`, {
            vpcId: this.vpc.id,
            tags: { Name: `${name}-public-nacl` },
        }, opts);

        this.privateNacl = new aws.ec2.NetworkAcl(`${name}-private-nacl`, {
            vpcId: this.vpc.id,
            tags: { Name: `${name}-private-nacl` },
        }, opts);

        // NACL Associations
        this.publicNaclAssociations = this.publicSubnets.map((subnet, index) =>
            new aws.ec2.NetworkAclAssociation(`${name}-public-nacl-assoc-${index + 1}`, {
                subnetId: subnet.id,
                networkAclId: this.publicNacl.id,
            }, opts)
        );

        this.privateNaclAssociations = this.privateSubnets.map((subnet, index) =>
            new aws.ec2.NetworkAclAssociation(`${name}-private-nacl-assoc-${index + 1}`, {
                subnetId: subnet.id,
                networkAclId: this.privateNacl.id,
            }, opts)
        );

        // Public NACL Rules (inbound + outbound)
        this.publicNaclRules = [
            { suffix: "inbound", egress: false },
            { suffix: "outbound", egress: true },
        ].map(rule =>
            new aws.ec2.NetworkAclRule(`${name}-public-nacl-${rule.suffix}`, {
                networkAclId: this.publicNacl.id,
                ruleNumber: 100,
                protocol: "-1",
                ruleAction: "allow",
                cidrBlock: "0.0.0.0/0",
                fromPort: 0,
                toPort: 0,
                egress: rule.egress,
            }, opts)
        );

        // Private NACL Rules (inbound + outbound)
        this.privateNaclRules = [
            { suffix: "inbound", egress: false },
            { suffix: "outbound", egress: true },
        ].map(rule =>
            new aws.ec2.NetworkAclRule(`${name}-private-nacl-${rule.suffix}`, {
                networkAclId: this.privateNacl.id,
                ruleNumber: 100,
                protocol: "-1",
                ruleAction: "allow",
                cidrBlock: "0.0.0.0/0",
                fromPort: 0,
                toPort: 0,
                egress: rule.egress,
            }, opts)
        );
    }
}
---
#aws/index.ts
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { ProviderResource } from "@pulumi/pulumi";
import { VpcResource } from "./services"
import { EksResource  } from "./services";


// Create an AWS provider for ap-south-1
const provider = new aws.Provider("ap-south-1", {
    region: "ap-south-1",
});

// Instantiate the VPC
const vpc = new VpcResource(provider, "staging", "ap-south-1", "10.0", "qa");

// Export useful outputs
// export const vpcId = vpc.vpc.id;
// export const publicSubnetIds = vpc.publicSubnets.map(s => s.id);
// export const privateSubnetIds = vpc.privateSubnets.map(s => s.id);
// export const natGatewayId = vpc.natGateway.id;


const eks = new EksResource(
    
    "staging",     // name
    vpc,           // your VpcResource instance
    "ap-south-1",  // region
    // "qa",          // environment
    // "1.32",        // k8s version
    // "t3.medium",   // node instance type
    // 2, 1, 4        // desired, min, max nodes
);
---
# aws/Pulumi.test.yaml
encryptionsalt: v1:hN1ROz+GaVs=:v1:7PZ4+yTBu9pU95KJ:UilrNCXIe+HPExZlqrUJjSh67ybxvQ==
config:
  aws:region: ap-south-1
  aws:profile: sajith
---
# aws/pulumi.yaml
name: infra
runtime: nodejs
description: A minimal TypeScript Pulumi program
backend:
  url: s3://test.beacon.infra/pulumi

  
