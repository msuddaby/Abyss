using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Abyss.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddJoinLeaveSystemMessages : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "JoinLeaveChannelId",
                table: "Servers",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "JoinLeaveMessagesEnabled",
                table: "Servers",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "IsSystem",
                table: "Messages",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "JoinLeaveChannelId",
                table: "Servers");

            migrationBuilder.DropColumn(
                name: "JoinLeaveMessagesEnabled",
                table: "Servers");

            migrationBuilder.DropColumn(
                name: "IsSystem",
                table: "Messages");
        }
    }
}
